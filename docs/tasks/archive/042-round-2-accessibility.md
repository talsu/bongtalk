# Round 2 — Accessibility

## AUDIT

- 도구: 확장된 input-label-guard (R0 F1 capital-case scan 추가) + icon-only button 정적 분석
- 범위: `apps/web/src/**`

발견:

```
$ pnpm test src/a11y/input-label-guard.spec.ts
... 1 passed (cover: <input>, <textarea>, <select>, <Input>, <Textarea>, <Select>, <TextField>)

$ python3 (icon-only button without aria-label)
TOTAL: 0
```

040 R2 9건 fix + 041 C 6건 ALLOWLIST 제거 + 042 R0 F1 capital-case 확장 누적 효과로 정적 audit 사각지대 없음.

## IDENTIFY

| ID  | 내용                               | 분류                                                                                  |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| A1  | input/textarea/select 라벨         | clean (guard 0 위반)                                                                  |
| A2  | Input/Textarea/Select capital-case | clean (R0 F1 cover)                                                                   |
| A3  | icon-only button aria-label        | clean (40 R2 + 인라인 grep 검증)                                                      |
| A4  | focus order / 키보드 nav           | 기존 e2e (`tab-navigation.e2e.ts`, `command-palette-a11y.e2e.ts`) cover               |
| A5  | axe-core e2e                       | 기존 `axe-scan.e2e.ts` (3 surface) — 채널/DM 통합 surface 확장은 prod e2e pipeline 시 |

**0 BLOCKER, 0 HIGH.**

## FIX

해당 없음.

## REGRESSION SPEC

기존 누적 cover. 신규 보강 불필요.

## VERIFY

green.

## DECIDE

R2 BLOCKER+HIGH = 0 + R1 도 0 → **2 round 연속 0** → R1+R2 dim
모두 converged 로 간주 (040 와 동일 패턴). 다음 R3 으로 진행.

## PROGRESS

| Round | BLOCKER | HIGH | MED+ 이월 | 회귀 spec      |
| ----- | ------- | ---- | --------- | -------------- |
| R2    | 0       | 0    | 0         | 0 (누적 cover) |
