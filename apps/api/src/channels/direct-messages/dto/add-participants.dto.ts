import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * S19 (FR-DM-07): POST /me/dms/:channelId/participants body 검증.
 *
 * 형식(배열·UUID)만 검증한다. cap(본인 포함 ≤20 → 초과 시 422 DM_GROUP_CAP_EXCEEDED)
 * 과 owner-only·친구/수신권한 게이트·부분추가금지는 **서비스 레이어**가 강제한다 —
 * DTO 에 @ArrayMaxSize 를 걸면 ValidationPipe 가 400 을 던져 422 계약이 깨진다.
 */
export class AddParticipantsDto {
  /** 추가할 멤버 userId 목록(각 UUID v4). 최소 1개. */
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  userIds!: string[];
}
