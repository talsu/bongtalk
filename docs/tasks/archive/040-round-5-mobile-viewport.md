# Round 5 — Mobile viewport

## 1. AUDIT

- 도구: 정적 grep + 모바일 e2e 헬퍼/스펙 전수
- 범위: `apps/web/e2e/mobile/**`, `apps/web/src/shell/mobile/**`,
  `apps/web/public/design-system/mobile.css`

발견:

- `_helpers.ts` 가 `MOBILE_VIEWPORT (375x667)` + `MOBILE_VIEWPORT_PRO
(390x844)` 만 노출. 040 task spec 은 **375x667 + 414x896 (iPhone
  XR/Plus)** 두 가지를 명시적으로 요구.
- 14 mobile polish e2e 스펙 모두 375 만 사용. 414 band 에서만 발생
  하는 spacing/overflow regression 은 잡지 못함.
- 안전영역: `qf-m-safe-top` / `qf-m-safe-bottom` 적용 다수, OK.
- 터치 타겟: DS `--m-touch: 44px` 상수 + `qf-m-tab` / `qf-m-tabbar` /
  `qf-m-icon-btn` 모두 준수.
- IME: composer / thread / message-edit / mobile-msg / command-palette
  모두 `isComposing || keyCode===229` 가드. ✓
- Address-bar collapse: app root 이 `html, body, #root { height:
100% }` 패턴이라 `100vh` 의 iOS 정적 동작 문제 회피. 자식 chain
  은 모두 `height: 100%` 이므로 dynamic viewport 변화에 자동 추적.
- Orientation change: 기존 `orientation-change.polish.e2e.ts` cover.
- 모바일 컴포넌트의 inline `width: '76px'` / `'48px'` 등 픽셀 값:
  iPhone SE (375) 기준으로 layout 검증된 baseline. 414 에서도
  rail 76 + main 338 = 414 OK. fix 불필요.

## 2. IDENTIFY

| ID   | 내용                                                   | 분류             |
| ---- | ------------------------------------------------------ | ---------------- |
| MV-1 | `MOBILE_VIEWPORT_XR` (414x896) 헬퍼 미정의             | HIGH (spec 명시) |
| MV-2 | 414 viewport 에서 critical mobile flow polish e2e 부재 | HIGH             |
| MV-3 | iPhone SE 미만 (320 width) 같은 극단 viewport 미지원   | LOW (의도적)     |

**2 HIGH (MV-1/2)**, 0 BLOCKER.

## 3. FIX

### MV-1 + MV-2: 414x896 helper + smoke spec

`apps/web/e2e/mobile/_helpers.ts`:

```ts
export const MOBILE_VIEWPORT_XR = { width: 414, height: 896 } as const;
export const MOBILE_VIEWPORTS = [MOBILE_VIEWPORT, MOBILE_VIEWPORT_PRO, MOBILE_VIEWPORT_XR] as const;
```

`apps/web/e2e/mobile/viewport-414-shell.polish.e2e.ts` (신규):

- 414x896 viewport 에서 `mobile-msg-input` 보이는지
- `documentElement.scrollWidth ≤ window.innerWidth` (수평 overflow 0)
- DM tab 의 `mobile-dm-search-input` 이 viewport bounds 내부

## 4. REGRESSION SPEC

| spec                                                     | cover                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/web/src/__tests__/mobile-viewport-helpers.spec.ts` | MV-1 정적 contract: `MOBILE_VIEWPORT_XR` + `MOBILE_VIEWPORTS` 가 `_helpers.ts` 에 존재 (1 test) |
| `apps/web/e2e/mobile/viewport-414-shell.polish.e2e.ts`   | MV-2 414x896 layout smoke (2 tests, e2e)                                                        |

## 5. VERIFY

```
$ pnpm verify
... 19/19 successful, 0 errors, 57 warnings
```

(첫 시도에서 typecheck process-killed transient + 헬퍼 export 누락
오류 발견 → 즉시 수정 후 retry green. VERIFY 3회 연속 실패 룰 미발동.)

## 6. DECIDE

R5 BLOCKER+HIGH = 2 → fix. R6 (Channel messages) 로 진행.

## 7. DEVELOP MERGE

(commit + merge 후 SHA 기록)

## 8. PROGRESS LOG

| Round | BLOCKER | HIGH      | MED+ 이월 | 회귀 spec                      |
| ----- | ------- | --------- | --------- | ------------------------------ |
| R5    | 0       | 2 (fixed) | 1         | 2 (helpers contract + 414 e2e) |
