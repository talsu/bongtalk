# Round N — `<dimension>`

> Round log template. 각 round 시작 시 `040-round-N-<dim>.md` 로 복사.

## 1. AUDIT

데스크톱 + 모바일 viewport 점검 결과:

- 환경: ...
- 도구: ... (Playwright + axe / grep / Performance API)
- 발견:

## 2. IDENTIFY

| ID  | 분류 | 내용 | 위치 | 분류 (BLOCKER/HIGH/MED/LOW) |
| --- | ---- | ---- | ---- | --------------------------- |
|     |      |      |      |                             |

## 3. FIX (BLOCKER + HIGH only)

| 변경 | commit / 파일 |
| ---- | ------------- |
|      |               |

MED+ → TODO(task-040-follow-...) backlog.

## 4. REGRESSION SPEC

| spec 파일 | cover 하는 fix |
| --------- | -------------- |
|           |                |

## 5. VERIFY

```
$ pnpm verify
...
```

- 결과: green / red
- 영향 spec: ...

## 6. DECIDE

- 이번 round BLOCKER+HIGH = ?
- 직전 round BLOCKER+HIGH = ?
- 결정: 다음 round 진행 / dim 완료 / cap 도달

## 7. DEVELOP MERGE

- commit SHA: ...
- develop merge SHA: ...

## 8. PROGRESS LOG

dimension matrix 업데이트:

| Round | BLOCKER | HIGH | MED+ 이월 | 회귀 spec |
| ----- | ------- | ---- | --------- | --------- |
|       |         |      |           |           |
