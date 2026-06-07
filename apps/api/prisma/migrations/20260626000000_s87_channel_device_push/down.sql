-- S87 down — 채널별 데스크톱/모바일 push 토글 롤백(reversible).
--
-- 두 컬럼은 신규 additive nullable 자산이라 DROP 으로 원천 데이터를 잃지 않는다(NULL=상속
-- 의미라 비-NULL 오버라이드를 둔 사용자는 글로벌 notifDesktop/notifMobile 로 복귀한다 —
-- push 전송 정확성만 약간 넓어질 뿐 데이터 손실은 채널 오버라이드 메타에 국한). 멱등 DROP.

ALTER TABLE "UserChannelMute" DROP COLUMN IF EXISTS "pushMobile";
ALTER TABLE "UserChannelMute" DROP COLUMN IF EXISTS "pushDesktop";
