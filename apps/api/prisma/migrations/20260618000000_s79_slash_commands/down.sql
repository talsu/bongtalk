-- Reverse of S79 (D15 / FR-SC-01·02·03) — 슬래시 커맨드 자동완성 토대(커스텀 전용 테이블).
--
-- 역순으로 되돌린다: (1) SlashCommand 테이블 DROP(FK·인덱스 CASCADE 동반),
-- (2) HandlerType enum DROP, (3) ResponseType enum DROP. 전 단계 IF EXISTS 가드로 멱등하다.
--
-- ★ 완전 가역: 신규 enum 2개 + 신규 테이블 1개라 다운그레이드 손실은 커스텀 슬래시 커맨드 행에
--   한정된다(S79 시점엔 행이 없음 — 빌트인은 상수, 커스텀 CRUD 는 S81). 자격증명·세션·메시징·
--   프로필은 무영향(이 마이그레이션이 손대지 않음). 테이블을 먼저 DROP 한 뒤(enum 의존) enum 을
--   DROP 한다(순서가 중요 — enum 컬럼이 살아 있으면 DROP TYPE 이 거부된다).

-- (1) SlashCommand 테이블 제거(FK·UNIQUE 인덱스 동반 — S79 fix-forward 로 중복 단순
--     인덱스를 제거했으므로 UNIQUE 인덱스 하나만 테이블과 함께 정리된다).
DROP TABLE IF EXISTS "SlashCommand";

-- (2) HandlerType enum 제거(컬럼 의존 해소 후).
DROP TYPE IF EXISTS "HandlerType";

-- (3) ResponseType enum 제거.
DROP TYPE IF EXISTS "ResponseType";
