# Round 1 — Visual consistency

## AUDIT

- 도구: 정적 grep + ESLint task-018 raw-value guard + DS md5 baseline 검사
- 범위: `apps/web/src/**/*.{ts,tsx,css}`

발견:

```
$ grep -rE "#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}\b" apps/web/src
apps/web/src/features/typing/TypingIndicator.tsx:// error #185` ...   (주석)

$ grep -rEn "['\"][0-9]+px['\"]" apps/web/src | grep -v tokens
apps/web/src/features/messages/MessageComposer.tsx: el.style.height = '0px';
apps/web/src/features/threads/ThreadPanel.tsx: el.style.height = '0px';
apps/web/src/shell/mobile/MobileDrawer.tsx: maxWidth: '360px'
apps/web/src/features/notifications/...: 1px border
```

041 D 작업 후 동일 baseline (14 → 4). 042 시작 시점에서 신규 raw 값
유입 0건. ESLint 가드 (`eslint.config.mjs` task-018) 가 빌드 타임에
계속 차단 중.

DS md5: baseline `.task-040-ds-baseline.txt` 100% 일치.

## IDENTIFY

| ID  | 내용                               | 분류                      |
| --- | ---------------------------------- | ------------------------- |
| V1  | raw hex 색 (주석만)                | clean                     |
| V2  | Tailwind `[Npx]` arbitrary 직접    | clean (0건)               |
| V3  | inline JS-string raw px (4건 합법) | clean                     |
| V4  | DS 4파일 변경                      | clean (md5 baseline 일치) |

**0 BLOCKER, 0 HIGH.** 040 R1 + 041 D 의 효과로 baseline 정착.

## FIX

해당 없음.

## REGRESSION SPEC

기존 `eslint.config.mjs` task-018 raw-value guard + 신규 audit 없음.

## VERIFY

`pnpm verify` green (Round 0 직후 그대로).

## DECIDE

R1 BLOCKER+HIGH = 0. 첫 audit 부터 clean → 040 R1 와 동일 패턴.
다음 dim 으로 이동 가능. 누적 verify 가 매 round 마다 ESLint 가드 + DS
md5 검사를 자동 재실행하므로 confirm round 별도 불필요.

## DEVELOP MERGE

코드 변경 없음 → R2 audit 종료 시점에 묶어 commit.

## PROGRESS

| Round | BLOCKER | HIGH | MED+ 이월 | 회귀 spec      |
| ----- | ------- | ---- | --------- | -------------- |
| R1    | 0       | 0    | 0         | 0 (기존 cover) |
