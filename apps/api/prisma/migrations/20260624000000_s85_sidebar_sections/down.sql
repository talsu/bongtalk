-- S85 down — 사이드바 개인 섹션 롤백(reversible).
--
-- 두 테이블(+ enum)은 전부 신규 additive 자산이라 DROP 으로 원천 데이터를 잃지 않는다
-- (개인 섹션/할당은 카테고리·채널 자체와 무관한 사용자 정렬 메타이며, 할당 삭제 시 채널은
-- 사이드바 기본 위치로 복귀한다). FK·인덱스는 테이블과 함께 사라지므로 테이블을 역순
-- (자식 → 부모)으로 DROP 한 뒤 enum 을 DROP 한다.

DROP TABLE IF EXISTS "UserSidebarChannelAssignment";
DROP TABLE IF EXISTS "UserSidebarSection";

DROP TYPE IF EXISTS "SidebarSectionSortMode";
