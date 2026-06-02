-- Reverse of S42 emoji aliases + user/workspace preferences.
--
-- 신규 테이블 3개라 down = DROP TABLE ×3. 각 테이블의 FK·인덱스는 DROP TABLE 과
-- 함께 사라지므로 별도 DROP 불요. 전부 additive 신규 테이블이라 다운그레이드 후
-- 데이터 손실은 그 3개 테이블에 한정된다(기존 CustomEmoji/User/Workspace 행은 무영향).
-- CustomEmojiAlias 를 먼저 떼는 이유: 다른 두 테이블과 의존이 없으므로 순서는 무관하나
-- up 의 역순(생성 순서 1→2→3 의 역 = 3→2→1)을 따른다.

DROP TABLE IF EXISTS "WorkspaceEmojiConfig";
DROP TABLE IF EXISTS "UserEmojiPreference";
DROP TABLE IF EXISTS "CustomEmojiAlias";
