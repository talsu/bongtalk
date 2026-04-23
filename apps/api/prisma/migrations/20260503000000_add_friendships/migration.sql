-- task-032-A: Friendship + FriendshipStatus enum + FRIEND_REQUEST
-- notification event. Reversible — new table + enum + single enum
-- value addition. No backfill; pre-existing users have zero rows in
-- Friendship.

ALTER TYPE "NotificationEventType" ADD VALUE IF NOT EXISTS 'FRIEND_REQUEST';

CREATE TYPE "FriendshipStatus" AS ENUM ('PENDING', 'ACCEPTED', 'BLOCKED');

CREATE TABLE "Friendship" (
  "id"          uuid PRIMARY KEY,
  "requesterId" uuid NOT NULL,
  "addresseeId" uuid NOT NULL,
  "status"      "FriendshipStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL,

  CONSTRAINT "Friendship_no_self" CHECK ("requesterId" <> "addresseeId"),
  CONSTRAINT "Friendship_requesterId_addresseeId_key" UNIQUE ("requesterId", "addresseeId"),
  CONSTRAINT "Friendship_requester_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "Friendship_addressee_fkey"
    FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX "Friendship_addresseeId_status_idx"
  ON "Friendship"("addresseeId", "status");

CREATE INDEX "Friendship_requesterId_status_idx"
  ON "Friendship"("requesterId", "status");
