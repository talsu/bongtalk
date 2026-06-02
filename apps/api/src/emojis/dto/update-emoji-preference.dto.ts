import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * S42 (FR-PK03): PUT /me/emoji-preferences 요청. 셋 다 optional — 명시된 필드만
 * 갱신한다. skinTone 1-6, quickReactions ≤3·각 ≤64자, recentEmojis ≤36. DTO 는
 * shape·기본 범위만 막고, 깊은 도메인 검증(빈 문자열·정확 길이)은 서비스가 단일
 * 출처로 수행한다(me-profile 선례 — 서비스가 권위 검증).
 */
export class UpdateEmojiPreferenceDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(6)
  defaultSkinTone?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  quickReactions?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(36)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  recentEmojis?: string[];
}
