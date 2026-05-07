-- task-046 iter6 (N1, N2, N3): thread follow / 구독.
--
-- 한 user 가 한 thread (root 메시지 ID) 를 follow. follow 상태는
-- mention dispatcher 가 thread reply 알림 분기에 사용.
--
-- - userId+threadParentId unique → 중복 follow 차단
-- - cascade on user / message hard-delete (purge worker only)
-- - 자동 follow: 사용자가 root 를 보낼 때 + 사용자가 reply 보낼 때
--   (서비스 layer 가 처리)
--
-- Reversible: DROP TABLE.

CREATE TABLE "ThreadSubscription" (
  "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"           UUID         NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "threadParentId"   UUID         NOT NULL REFERENCES "Message" ("id") ON DELETE CASCADE,
  "createdAt"        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "ThreadSubscription_userId_threadParentId_key"
  ON "ThreadSubscription" ("userId", "threadParentId");

-- 알림 분기: dispatcher 가 한 thread 의 모든 follower 조회 시 (threadParentId)
-- 으로 lookup.
CREATE INDEX "ThreadSubscription_threadParentId_idx"
  ON "ThreadSubscription" ("threadParentId");
