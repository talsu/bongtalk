-- Reverse of S60 링크 unfurl 결과 테이블.
--
-- 역순으로 되돌린다: (1) FK DROP, (2) 인덱스 DROP, (3) TABLE DROP. DROP TABLE 만으로도
-- 인덱스·FK 가 함께 사라지지만(PG 의존성 cascade), 명시 역순 + IF EXISTS 가드로 부분
-- 적용 상태에서도 안전하게 되돌린다. 신규 테이블이라 다운그레이드 손실은 unfurl 결과
-- (OG 카드 메타)에 한정된다 — 다음 발화 시 UnfurlProcessor 가 재생성한다(Redis/MinIO
-- 캐시는 TTL/GC 로 자연 소멸). 기존 Message 행은 무영향.

DO $$ BEGIN
  ALTER TABLE "MessageEmbed" DROP CONSTRAINT "MessageEmbed_messageId_fkey";
EXCEPTION WHEN undefined_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

DROP INDEX IF EXISTS "MessageEmbed_cacheKey_idx";
DROP INDEX IF EXISTS "MessageEmbed_messageId_idx";
DROP INDEX IF EXISTS "MessageEmbed_messageId_cacheKey_key";

DROP TABLE IF EXISTS "MessageEmbed";
