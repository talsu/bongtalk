import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * S42 (FR-PK03): PUT /me/emoji-preferences 요청. 셋 다 optional — 명시된 필드만
 * 갱신한다. skinTone 1-6, quickReactions ≤3·각 1~64자, recentEmojis ≤36. DTO 는
 * shape·기본 범위만 막고(빈 문자열은 여기서 차단), 깊은 도메인 검증(정확 길이)은
 * 서비스가 단일 출처로 수행한다(me-profile 선례 — 서비스가 권위 검증).
 *
 * S42 fix-forward (LOW): 각 원소에 @MinLength(1, { each: true }) 를 추가해 빈
 * 문자열을 DTO 레이어에서 차단한다(서비스 이중방어 보완).
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
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  quickReactions?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(36)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  recentEmojis?: string[];
}
