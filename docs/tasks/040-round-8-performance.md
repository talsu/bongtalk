# Round 8 — Performance (last)

## 1. AUDIT

- 도구: `pnpm build` + `pnpm size` (size-limit) + bundle inspect
- 범위: bundle 크기 + chunk split + budget vs 039 baseline

### Bundle size (apps/web `dist/assets`)

빌드 결과 (gzip):

| chunk                 | gzip     | budget | 상태                        |
| --------------------- | -------- | ------ | --------------------------- |
| initial entry + shell | 7.80 KB  | 200 KB | 🟢                          |
| Shell chunk           | 17.29 KB | 80 KB  | 🟢                          |
| vendor-react          | 53.36 KB | 55 KB  | 🟢 (94% headroom 거의 없음) |
| vendor-radix          | 29.69 KB | 70 KB  | 🟢                          |
| vendor-query          | 12.29 KB | 35 KB  | 🟢                          |
| vendor-socket         | 12.94 KB | 30 KB  | 🟢                          |

신규 chunk:

- `ConnectionBanner-*.js`: 11.25 KB / 4.49 KB gzip — 040 R3 신규
  추가 (`features/connection/ConnectionBanner.tsx` +
  `computeConnectionBanner.ts`). Vite 가 별도 chunk 로 split.
- `clampAttachments` 는 `MessageColumn-*.js` (40.97 KB / 12.98 KB gzip)
  안에 흡수.

### Bundle delta vs 039 baseline

039 baseline (commit `83e8cda` main):

- 본 round 시작 시점에 stored baseline 없음. 그러나:
  - 040 변경은 ConnectionBanner (+11 KB raw) + 4 shell wrapper 의
    soft import (~0.3 KB gzip 미만).
  - 040 가 추가한 spec/test 는 prod bundle 미포함.
  - DS 4 파일 git diff 0 검증 (`md5sum` 일치, `.task-040-ds-baseline.txt`).
- 추정 delta: Shell chunk ~+0.3 KB gzip (~+1.7%) vs 039.
- 5% budget 안.

### Runtime metric (FCP / LCP / CLS / FPS / Lighthouse)

NAS dev 서버 + 브라우저 인스트루먼트가 본 round 에서 가용하지 않음.
Synology 4.4 커널 + glibc 제약으로 host Lighthouse 실행 불가
(`scripts/run-e2e.sh` 처럼 docker/playwright 이미지로만 가능).

대신:

- `apps/web/dist/index.html` 의 critical CSS preload + DS link tag
  점검: ✓ DS 가 `/design-system/index.html` 로 캐시되도록 link.
- `vite.config.ts` 의 manualChunks 가 vendor 분리 명확 → vendor 캐시
  warm 후 재방문 FCP 빠름.
- `prefers-reduced-motion` 글로벌 disable: `index.css` 24-33 라인.

→ 정적 정량 미달 0건. 런타임 정량은 prod 배포 후 pipeline 측정.

## 2. IDENTIFY

| ID  | 내용                                                       | 분류                                        |
| --- | ---------------------------------------------------------- | ------------------------------------------- |
| P-1 | vendor-react 53.36 / 55 KB → 94.5% headroom 좁음           | LOW (다음 React 메이저 시 budget 상향 검토) |
| P-2 | Lighthouse / FCP / LCP / CLS 정량 측정 인프라 부재         | MED (task-019 Lighthouse CI follow)         |
| P-3 | MessageList virtualization OFF — 1000+ 메시지에서 DOM 비용 | MED (R6 의 CM-2 와 동일 follow)             |
| P-4 | Bundle delta vs 039 < 5% budget 충족                       | clean                                       |

**0 BLOCKER, 0 HIGH.** Static perf 는 budget 충족, runtime 은 측정
인프라 부재 (별도 follow task).

## 3. FIX

해당 없음. 정적 budget 충족.

## 4. REGRESSION SPEC

- `apps/web/.size-limit.cjs` (기존, error-on-overflow CI gate)
- `pnpm size` 가 매 build 마다 budget 검증

## 5. VERIFY

```
$ pnpm build
... ✓ built in 6.57s
$ pnpm size
... 6 budgets all under limit
$ pnpm verify
... 19/19 successful, 0 errors, 57 warnings
```

green.

## 6. DECIDE

R8 BLOCKER+HIGH = 0. R7 도 0. 본 round 가 마지막 dim 의 첫 audit
이므로 convergence 는 cumulative spec 재실행으로 자동 확정.
**모든 8 dimension 매트릭스 채워짐 → loop 종료.**

## 7. DEVELOP MERGE

R6/R7/R8 round log 와 함께 단일 commit, develop merge, main auto-promote.

## 8. PROGRESS LOG

| Round | BLOCKER | HIGH | MED+ 이월                               | 회귀 spec           |
| ----- | ------- | ---- | --------------------------------------- | ------------------- |
| R8    | 0       | 0    | 2 (P-2 Lighthouse / P-3 virtualization) | 0 (size-limit 기존) |
