-- S77c (D14 / FR-PS-16·19) — 계정 비활성화/재활성화 + 30일 익명화 토대.
--
-- 본 마이그레이션은 ADDITIVE + reversible 이며 단일 트랜잭션(prisma migrate deploy)으로
-- 적용한다. User 에 비활성화 상태 컬럼 2개를 ADD 한다:
--
--   isDeactivated(BOOLEAN NOT NULL false) — 계정 비활성화 여부. 기존 row 는 false 로
--     backfill(무회귀 — 게이트만 추가). POST /users/me/deactivate 가 true 로,
--     /users/me/reactivate 가 false 로 전환한다. JwtStrategy 가 매 요청 이 컬럼을 보고
--     비활성 계정 요청을 ACCOUNT_DEACTIVATED 로 차단한다.
--   deactivatedAt(TIMESTAMPTZ NULL)        — 비활성화 시각(UTC). null = 활성. 30일 익명화
--     크론이 `deactivatedAt < now-30d` 인 row 만 골라 PII null화 + 메시지 익명화를 수행한다
--     (30일 미만/활성 row 는 절대 미접근). reactivate 시 null 로 되돌린다.
--
-- ★ NO CONCURRENTLY: `prisma migrate deploy` 가 단일 트랜잭션으로 실행하므로 트랜잭션
--   블록에서 금지되는 CONCURRENTLY 를 쓰지 않는다(인덱스는 일반 CREATE INDEX).
-- ★ 완전 가역: additive 컬럼 2개라 down.sql 은 두 컬럼 DROP 으로 무손실 역행한다(s73/s77a/s77b
--   "additive 컬럼 = 완전 가역" 선례). 다운그레이드 손실은 비활성화 상태값에 한정되며
--   자격증명·세션·메시징·프로필은 무영향(이 마이그레이션이 손대지 않음).
-- ★ 멱등 가드(ADD COLUMN 은 IF NOT EXISTS)로 기존 패턴과 일관. PG16 throwaway DB 로 up→down→up 검증.
-- ★ ANONYMOUS 시스템 사용자(Message.authorId 익명화 타겟)는 마이그레이션 데이터 변형이 아니라
--   seed.ts 의 기존 SYSTEM_ANON(user:system-anon · S72)을 재사용한다 — 마이그레이션은 스키마만 변경한다.
-- ★ 익명화 크론이 `deactivatedAt < cutoff` 인 row 만 LIMIT 500 배치로 스캔하므로 부분 인덱스를
--   고려했으나, 비활성 계정은 전체 대비 극소수이고 크론 빈도가 낮아(일 1회) 풀 스캔 비용이 무시
--   가능하다 — 인덱스를 추가하지 않아 쓰기 경로 비용을 늘리지 않는다(perf 보수적 선택).

-- ── User 비활성화 컬럼 2개 ───────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isDeactivated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMPTZ;
