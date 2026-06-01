import { IsIn } from 'class-validator';

/**
 * S20 (FR-DM-10): PATCH /me/dms/:channelId/visibility {visibility} body 검증.
 *
 *  - HIDDEN  → 요청자 USER override 의 hiddenAt 을 now 로 세팅(사이드바 목록 제외).
 *  - VISIBLE → hiddenAt 을 NULL 로 클리어(목록 복귀, 수동 복원).
 *
 * 상대방의 새 메시지가 도착하면 send 경로가 수신자 hiddenAt 을 자동 복원한다
 * (보낸 본인 제외 — FR-DM-10). 이 엔드포인트는 본인의 수동 토글 경로다.
 */
export class SetDmVisibilityDto {
  @IsIn(['HIDDEN', 'VISIBLE'])
  visibility!: 'HIDDEN' | 'VISIBLE';
}
