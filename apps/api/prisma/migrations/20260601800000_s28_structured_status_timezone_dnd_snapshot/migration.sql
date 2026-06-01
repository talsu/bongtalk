-- S28 (FR-P04/P17/P06) — 커스텀 상태 구조화 + timezone + DND 스케줄 snapshot.
--
-- 기존 User.customStatus(VarChar(100)) 는 "텍스트" 컬럼으로 그대로 둔다(회귀 없음 —
-- /me/profile, GET /me/profile/status 가 계속 읽는다). 여기에 Discord-parity 커스텀
-- 상태를 완성하기 위해 emoji / expiresAt / timezone 을 ADDITIVE 로 더한다.
--
--   customStatusEmoji      — 짧은 이모지 또는 :shortcode: (FR-P04). null = 없음.
--   customStatusExpiresAt  — 만료 시각(UTC, timestamptz). null = 무기한(FR-P04/P17).
--                            FR-P17 만료는 read-time lazy clear 로 처리한다(BullMQ
--                            부재). 프리셋('오늘 자정'/30분/1시간/이번주)은 서버가
--                            User.timezone(IANA) 기준으로 계산해 UTC 로 저장한다.
--   timezone               — IANA timezone(예: "Asia/Seoul"). null = 미설정 →
--                            클라 브라우저 tz fallback(FR-P04).
--
-- DND 스케줄 auto-toggle(FR-P06):
--   dndScheduleSnapshot    — 스케줄 구간 "진입" 시 직전 presencePreference 를 보관해
--                            구간 "종료" 시 복원할 수 있게 한다. 진입하지 않은 평시엔
--                            null. shape: { prev: "auto" | "dnd" | "invisible" }.
--
-- 안전성: ADDITIVE. nullable 컬럼 4개 추가만으로 기존 row/컬럼/인덱스/제약을 건드리지
-- 않는다(회귀 없음). 테이블 재작성 없음 → NAS 라이브 무중단. 기존 row 는 모두 NULL 로
-- 남고 다음 상태/스케줄 갱신에서 채워진다.
--
-- Reversible: down.sql 이 정확한 역순(DROP COLUMN ×4)으로 되돌린다. 파생/부가 표시값
-- 이라 컬럼 제거 시 도메인 손실이 없다(PG16 up→down→up 검증 대상).

ALTER TABLE "User" ADD COLUMN "customStatusEmoji" VARCHAR(64);
ALTER TABLE "User" ADD COLUMN "customStatusExpiresAt" TIMESTAMPTZ;
ALTER TABLE "User" ADD COLUMN "timezone" VARCHAR(64);
ALTER TABLE "User" ADD COLUMN "dndScheduleSnapshot" JSONB;
