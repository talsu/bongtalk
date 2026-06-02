import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * S42 (FR-PK04): 워크스페이스 이모지 설정 변경 요청. 둘 다 optional — 명시된 필드만
 * 갱신한다. quickReactions 는 ≤3개·각 1~64자(서비스가 추가 검증), canMemberUpload 는
 * boolean. 깊은 도메인 검증(개수·문자열)은 서비스 레이어가 단일 출처로 수행한다.
 *
 * S42 fix-forward (LOW): 각 원소에 @MinLength(1, { each: true }) 를 추가해 빈
 * 문자열을 DTO 레이어에서 차단한다(서비스 이중방어 보완).
 */
export class UpdateWorkspaceEmojiConfigDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  quickReactions?: string[];

  @IsOptional()
  @IsBoolean()
  canMemberUpload?: boolean;
}
