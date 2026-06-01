import { IsISO8601, IsOptional, ValidateIf } from 'class-validator';

/**
 * S20 (FR-DM-11): PATCH /me/dms/:channelId/mute {mutedUntil} body 검증.
 *
 *  - mutedUntil: null   → 무기한 뮤트(기존 UserChannelMute.mutedUntil = NULL 규약).
 *  - mutedUntil: ISO8601 → 그 시각까지만 뮤트(만료는 query-time 필터로 자동 제외).
 *
 * `@ValidateIf(v => v.mutedUntil !== null)` 로 명시적 null 을 허용하면서, 값이
 * 있을 때만 ISO8601 형식을 강제한다(@IsOptional 은 undefined 만 통과시키므로
 * null 을 명시적으로 허용하기 위해 ValidateIf 를 함께 둔다). 뮤트는 기존 mute
 * 서비스의 upsert 규약(mute > event-type pref)을 그대로 재사용한다.
 */
export class SetDmMuteDto {
  @IsOptional()
  @ValidateIf((o: SetDmMuteDto) => o.mutedUntil !== null)
  @IsISO8601()
  mutedUntil!: string | null;
}
