-- Reverse of S80 (D15 / FR-SC-06) — /remind 리마인더 모델.
--
-- 역순으로 되돌린다: (1) Reminder 테이블 DROP(FK·인덱스 CASCADE 동반),
-- (2) ReminderStatus enum DROP. 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: 신규 enum 1개 + 신규 테이블 1개라 다운그레이드 손실은 예약된 리마인더 행에
--   한정된다. 메시징·저장함·프로필·세션은 무영향(이 마이그레이션이 손대지 않음). 테이블을
--   먼저 DROP 한 뒤(enum 의존) enum 을 DROP 한다(순서가 중요 — enum 컬럼이 살아 있으면
--   DROP TYPE 이 거부된다).

-- (1) Reminder 테이블 제거(FK·인덱스 동반).
DROP TABLE IF EXISTS "Reminder";

-- (2) ReminderStatus enum 제거(컬럼 의존 해소 후).
DROP TYPE IF EXISTS "ReminderStatus";
