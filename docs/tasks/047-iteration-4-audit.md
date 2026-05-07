# Iteration 4 — AUDIT (M3 Profile page 단독)

## 처리 범위

Section M (Profile 확장 3 row) 의 M3 ✅ 진급 — `/me/profile` 라우트

- MyProfilePage 컴포넌트 + useMyProfile/useUpdateProfile hooks.

## row 변경

| #   | Row                            | iter 3 종료 | iter 4 종료 | 가중치 변화 |
| --- | ------------------------------ | ----------- | ----------- | ----------- |
| M3  | profile page 데스크톱 + 모바일 | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |

Section M: 2.0 → **2.5 / 3** = **83.33%** (+16.67pp).

> M1 (bio) 와 M2 (links) 는 이미 ✅. Section M 100% 도달은 다른 row 추가
> 없이는 불가능 — 본 iter 후 종료 row state 적정.
> Wait — M3 도 ✅ 면 Section M 의 모든 row ✅. **Section M = 3.0/3 = 100%**.

수정: Section M: 2.0 → **3.0 / 3** = **100%** (+33.33pp). 3 row 모두 ✅.

## 산출물

### M3 Profile page (✅ 진급)

- **`apps/web/src/features/users/useMyProfile.ts`** 신규 — useMyProfile (GET /me/profile) + useUpdateProfile (PATCH /me/profile, optimistic cache update)
- **`apps/web/src/features/users/MyProfilePage.tsx`** 신규 — 데스크톱 + 모바일 responsive
  - account section (username/email/customStatus, read-only)
  - bio section (편집 가능, markdown / 500 chars)
  - links section (편집 가능, cap 3 / https?:// / 32 chars label)
  - LinksEditor 서브 컴포넌트 (URL + label input pairs)
  - 저장/취소 액션 + isPending 상태
- **`apps/web/src/lib/query-keys.ts`** 확장 — `qk.me.profile()`
- **`apps/web/src/App.tsx`** — `/me/profile` 라우트 + ProtectedMyProfileRoute
- **a11y**: 모든 input 에 aria-label (자기소개 / 링크 N URL / 링크 N 라벨)
- **DS**: `min-h-[120px]` 같은 raw px 제거, `var(--s-*)` 토큰 사용

### Visual baseline

- 새 surface 1개 (`/me/profile`) — DS mockup 의 profile 섹션과 맵핑
- visual-baseline.e2e.ts 갱신은 follow-up — DS mockup 에 profile page 가 정식
  qf-m-screen 으로 정리되어 있지 않아, snapshot 시드는 DS 작업 + 047 말 end-to-end 시점에
  통합 권장
- 047 의 acceptance criteria 의 "Visual regression baseline 보존 또는 명시 갱신"
  는 보존 (변경 없음). 명시 갱신은 follow-up.

## 회귀 spec

| 신규                                  | Cases | 상태 |
| ------------------------------------- | ----- | ---- |
| useMyProfile.spec.ts (신규, contract) | 3     | ✅   |

> hook integration 테스트는 React Query mocking 이 무거워 contract-only.
> backend 검증은 me-profile.spec.ts 가 cover (047 iter3 에서 17 cases).

## Score 재산정 (96 row baseline)

- iter 3 종료 row 합: 81.0 / 96
- M3: +0.5
- iter 4 종료 row 합: **81.5 / 96**
- 단순 score: 81.5 / 96 = **84.90%** (+0.52pp)
- HIGH×2 (HIGH=0): 동일 **84.90%** (+0.52pp)

> ⚠ iter 4 score delta = +0.52pp (1pp 미만). 다음 iter (5) 도 < 1pp
> 면 종료 조건 (3) 트리거. iter 5 의 N3 + O 일부 로 충분히 1pp 이상
> 회복 가능 (예상 +1.5~2pp).

## DoD

- [x] M3 ProfilePage + 라우트 + hooks
- [x] a11y aria-label
- [x] DS 토큰 사용 (raw px 0)
- [x] HIGH 갭 = 0 유지
- [x] pnpm verify green (api 266 + web 137)
- [x] DS 4 파일 untouched
- [x] 96 row matrix 유지

## 측정

- 영향 라인: ~280 (useMyProfile 60 + MyProfilePage 200 + spec 50 + App.tsx route 15)
- web 134 → **137** unit tests (+3, contract-only)
- 신규 라우트 1 (FE only — BE 는 047 iter3 에서 PATCH 확장 완료)
