-- S27 (FR-P10) — User.lastSeenAt 추가.
--
-- 마지막 접속(presence 가 OFFLINE 으로 확정되거나 DND 로 전환될 때) 시각을
-- 기록한다. 멤버 목록의 오프라인 그룹에서 "마지막 접속 N분 전" 표기에 쓰인다.
--   - OFFLINE 확정(presence grace 만료, finalizeOffline) → lastSeenAt = now
--   - DND 전환(PATCH /me/presence { status: dnd }) → lastSeenAt = now
--   - INVISIBLE 전환 → 미갱신(FR-P10). invisible 은 타인에게 offline 으로
--     마스킹되지만 그 시점을 "마지막 접속"으로 노출하면 잠적 시각이 누출되므로
--     의도적으로 lastSeenAt 을 건드리지 않는다.
--
-- 안전성: ADDITIVE. nullable 컬럼 1개 추가일 뿐 기존 row/컬럼/인덱스/제약을
-- 건드리지 않는다(회귀 없음). 기존 row 는 NULL(=접속 기록 없음)로 남고, 다음
-- OFFLINE/DND 전환에서 채워진다. timestamptz 라 TZ-aware 다. 테이블 재작성 없음
-- → NAS 라이브 무중단.
--
-- Reversible: down.sql 동반(DROP COLUMN). 파생 표시값이라 손실 무해.

ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMPTZ;

-- S27 fix-forward(perf) — WorkspaceMember keyset 정렬 인덱스.
--
-- 그룹 멤버 목록은 workspace 내에서 (joinedAt, userId) 순으로 정렬하고 1000명
-- 미만이면 전체를 적재한다. 이 정렬 인덱스가 적재+정렬을 O(N) 으로 유지해
-- 1000명 규모에서도 전체-테이블 정렬을 피한다. ADDITIVE — 신규 인덱스 1개만
-- 추가하며 기존 PK/인덱스/row 를 건드리지 않아 회귀가 없다. 테이블 재작성 없음.
--
-- Reversible: down.sql 이 DROP INDEX 로 역연산한다.
CREATE INDEX "WorkspaceMember_workspaceId_joinedAt_userId_idx"
  ON "WorkspaceMember" ("workspaceId", "joinedAt", "userId");
