-- FR-MN-10 (Task 066 / S93) perf fix-forward: 키워드 watcher 조회용 부분 인덱스.
--
-- mention-scan 워커(2)는 메시지마다 다음 쿼리로 후보 watcher 를 찾는다:
--   SELECT us."userId", us."keywords"
--     FROM "UserSettings" us
--     JOIN "WorkspaceMember" wm ON wm."userId"=us."userId" AND wm."workspaceId"=$ws
--    WHERE array_length(us."keywords",1) > 0 AND us."userId" <> $actor
--
-- 인덱스가 없으면 플래너는 워크스페이스 전 멤버를 돌며 각 멤버의 UserSettings 를
-- lookup 해 array_length 를 평가한다 → 비용 O(워크스페이스 멤버 수)(키워드 보유자
-- 0명인 대형 워크스페이스도 동일). 키워드 채택률은 보통 낮으므로, 이 부분 인덱스는
-- 플래너가 "키워드 보유자" 집합에서 출발해 WorkspaceMember PK 로 조인하는 plan 을
-- 선택할 수 있게 한다(키워드 보유자만 스캔 → 멤버 수와 무관).
--
-- ★부분 인덱스(raw SQL 전용): Prisma schema 는 WHERE 절 인덱스를 표현하지 못하므로
--   (Message_channel_roots_idx 선례와 동일) 이 인덱스는 마이그레이션에만 존재하고
--   schema.prisma 에는 없다. migrate deploy 는 drift 검사를 하지 않아 무해하다.
-- ★UserSettings 는 사용자당 1행(소형 테이블)이라 비-CONCURRENT CREATE INDEX 로 충분
--   하다(짧은 잠금 · CONCURRENTLY 는 Prisma 의 tx 래핑과 충돌하므로 회피). forward-safe.
CREATE INDEX "UserSettings_keyword_watchers_idx"
  ON "UserSettings"("userId")
  WHERE array_length("keywords", 1) > 0;
