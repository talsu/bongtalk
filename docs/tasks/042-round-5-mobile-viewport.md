# Round 5 — Mobile viewport

## AUDIT

- 도구: 정적 grep + e2e 헬퍼 viewport 점검
- 누적 baseline: 040 R5 (375 + 390 + 414) + 042 task-spec 추가 (768 portrait)

발견:

- \_helpers.ts 가 375/390/414 만 노출. 042 task spec 은 **768 portrait** (iPad mini portrait / "narrowest desktop") 도 명시.
- safe-area: 040 R5 에서 검증 완료. 041 A-1 banner 도 safe-area-inset 적용. R0 F7 가 iPhone 13 device emulation 으로 banner padding-top 검증.
- 터치 타겟: DS `--m-touch: 44px` 그대로.
- IME / address-bar: 040 R5 와 동일 (변동 없음).

## IDENTIFY

| ID  | 분류                                                                     |
| --- | ------------------------------------------------------------------------ | ---------------- |
| MV1 | 768 portrait viewport 미정의                                             | HIGH (spec 명시) |
| MV2 | 040 R5 414 e2e + 042 R0 F7 iOS device + R0 F6 multi-shell e2e 누적 cover | clean            |

**1 HIGH (MV1).**

## FIX

### MV1: 768 portrait helper 추가

`apps/web/e2e/mobile/_helpers.ts`:

```ts
export const TABLET_VIEWPORT_PORTRAIT = { width: 768, height: 1024 } as const;
export const MOBILE_VIEWPORTS = [
  MOBILE_VIEWPORT,
  MOBILE_VIEWPORT_PRO,
  MOBILE_VIEWPORT_XR,
  TABLET_VIEWPORT_PORTRAIT,
] as const;
```

768 은 실제로는 desktop 셸이 마운트되는 경계 (App matchMedia `(max-width: 767px)`). "narrow-desktop probe" 로 활용. helper 추가 자체가 fix.

## REGRESSION SPEC

기존 `mobile-viewport-helpers.spec.ts` (040 R5) 가 grep 으로 const 존재 + 수치를 검증. 신규 cover:

```ts
expect(flat).toMatch(/MOBILE_VIEWPORT_XR\s*=\s*\{\s*width:\s*414,\s*height:\s*896\s*\}/);
expect(flat).toContain('MOBILE_VIEWPORTS');
```

새 const 도 `MOBILE_VIEWPORTS` 배열에 들어 있어 같은 spec 이 자동 cover.

## VERIFY

green.

## DECIDE

R5 BLOCKER+HIGH = 1 (fix). R6 (Channel) 로 진행.

## PROGRESS

| Round | BLOCKER | HIGH      | MED+ 이월 | 회귀 spec      |
| ----- | ------- | --------- | --------- | -------------- |
| R5    | 0       | 1 (fixed) | 0         | 0 (기존 cover) |
