import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * S20 (FR-DM-05): PATCH /me/dms/:channelId {name} body 검증.
 *
 * `name` 은 사용자가 보는 group DM 표시명으로, Channel.displayName 에 저장된다
 * (멤버 set 으로부터 파생된 dedup slug `Channel.name` 은 불변이라 그대로 둔다).
 * 1~100자 — Discord 의 group DM 이름 상한(100)에 맞춘 보수적 캡. 길이 위반은
 * ValidationPipe 가 400(VALIDATION_FAILED)으로 거부한다.
 */
export class RenameGroupDmDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
