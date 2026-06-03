-- S61 (D12) DOWN — 커스텀 Role 시스템 역마이그레이션.
--
-- up 의 역순으로 되돌린다:
--   6/5. MemberRole · Role 행 제거(테이블 DROP 으로 함께 사라짐).
--   4/3. MemberRole · Role 테이블 DROP(FK·인덱스 동반 제거).
--   2.   ChannelPermissionOverride allow/denyMask BigInt → Int 환원.
--   1.   WorkspaceRole enum: MODERATOR/GUEST 를 쓰는 row 를 MEMBER 로 환원.
--        ★ enum 값 자체는 PG 제약(ALTER TYPE DROP VALUE 불가)으로 제거 불가.
--          미사용 상태로 남겨 무해하다(재-up 시 다시 사용).

-- ── 1. enum 값을 쓰는 row 를 안전한 인접 값으로 환원 ────────────────────────
-- 3단계 스키마(OWNER/ADMIN/MEMBER)에는 MODERATOR/GUEST 가 없으므로 MEMBER 로
-- 강등한다. backfill 로 만든 MemberRole 은 5번에서 테이블째 사라진다.
UPDATE "WorkspaceMember" SET "role" = 'MEMBER'
  WHERE "role" IN ('MODERATOR', 'GUEST');

-- ── 2. allow/denyMask BigInt → Int 환원 ────────────────────────────────────
-- up 에서 만든 값은 0~0xFF 범위라 Int 로 무손실 환원된다. 단, down 시점에 64비트
-- 값이 들어있다면(신규 코드가 ADMINISTRATOR 등을 저장) Int 범위를 초과해 실패한다
-- — down 은 신규 코드 롤백과 함께 수행해야 안전하다(컬럼 마이그레이션의 일반 제약).
ALTER TABLE "ChannelPermissionOverride"
  ALTER COLUMN "allowMask" SET DATA TYPE INTEGER USING "allowMask"::integer,
  ALTER COLUMN "denyMask"  SET DATA TYPE INTEGER USING "denyMask"::integer;

-- ── 3/4. MemberRole · Role 테이블 DROP(FK·인덱스 동반) ──────────────────────
DROP TABLE IF EXISTS "MemberRole";
DROP TABLE IF EXISTS "Role";

-- ── 1(주석). WorkspaceRole enum 값 제거 불가 안내 ───────────────────────────
-- PostgreSQL 은 enum 값을 안전하게 DROP 할 수 없다. MODERATOR/GUEST 는 위에서
-- 미사용 상태가 되었으므로 그대로 둔다. enum 을 완전히 3단계로 되돌리려면
-- 새 타입 생성 + 컬럼 재캐스트 + 기존 타입 DROP 의 별도 데이터-마이그레이션이
-- 필요하며, 이는 본 down 의 범위를 벗어난다(운영 위험 ↑). throwaway DB 검증은
-- up→down→up 사이클이 신규 테이블/컬럼 기준으로 무손실임을 확인하는 데 목적이 있다.
