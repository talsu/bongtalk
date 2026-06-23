# Iteration 1 — PLAN (matrix expansion, audit-only)

## 목적

기존 60+ row 매트릭스 (045 종료 95%) 에 신규 dimension 8개 추가하여
매트릭스 자체를 확장. score 일시 하락 (95% → 85-88%) 측정.

**code 변경 0**, audit doc 만 산출. deploy 없음 (commit 만, develop merge X).

## 산출

- `docs/tasks/046-iteration-1-audit.md` — 신규 row + 우선순위 + score
- 가중치 룰 (044/045 동일): 완성=1.0 / 부분=0.5 / 계획=0.25 / 없음=0
- HIGH 갭 가중치 ×2 그대로

## 신규 dimension 8

1. **모바일 surface 확장** (8 row)
2. **검색 깊이** (4 row)
3. **알림 다양성** (4 row)
4. **Keyboard shortcut cheat sheet** (3 row)
5. **Profile 확장** (3 row)
6. **Thread follow / 구독** (3 row)
7. **Empty state 풍부화** (~7 row, 영역 단위)
8. **Error recovery 일관성** (~4 row, 카테고리 단위)

총 신규 36 row → 매트릭스 ≈ 96 row.

## 우선 순위 (HIGH 추출)

audit 단계에서 처리 후 iter 2~N 계획 수립.
권장 순서 (046 task 명세 기준):

- iter 2: 모바일 (visual baseline 8 추가)
- iter 3: 검색
- iter 4: 알림 (단독)
- iter 5: 단축키 + 프로필
- iter 6: thread follow + empty state
- iter 7: error recovery
- iter 8+: AUDIT 결과 기반

## 변경 안 함

- 코드 / migration / DS / 라우트 / WS event
- baseline / snapshot / fixture
