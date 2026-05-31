-- S12 rollback.
--
-- (2) 부분 유니크 → 전체-테이블 유니크 복원. 부분 유니크 도입 후 삭제→동명
-- 재생성이 일어났다면 활성/삭제 행을 통틀어 (workspaceId,name) 중복이 존재해
-- 전체 유니크 생성이 실패한다(review S12 major-1). 롤백이 막히지 않도록 복원
-- 전에 **soft-deleted 중복 행을 purge** 한다(활성 행과 동명인 삭제 행만 제거 —
-- 이미 삭제된 행이라 데이터 손실 의미 없음). 활성-활성 중복은 부분 유니크가
-- 애초에 막았으므로 남지 않는다.
--
-- (1) FORUM enum 값은 되돌리지 않는다 — Postgres 는 사용 중일 수 있는 enum 값의
-- 단일 DROP 을 지원하지 않는다. FORUM 행을 다른 타입으로 옮긴 뒤 enum 을 재생성
-- 하는 경로가 필요하며, 여기 스크립트화하지 않는다(027 DIRECT 와 동일 정책).

DELETE FROM "Channel" a
USING "Channel" b
WHERE a."deletedAt" IS NOT NULL
  AND b."deletedAt" IS NULL
  AND a."workspaceId" = b."workspaceId"
  AND a."name" = b."name";

DROP INDEX IF EXISTS "Channel_workspaceId_name_active_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "Channel_workspaceId_name_key"
  ON "Channel"("workspaceId", "name");
