import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class PresignEmojiUploadDto {
  @Matches(/^[a-z0-9_]{2,32}$/)
  name!: string;

  // task-037 reviewer MED-2: enum-restrict at the DTO layer so the
  // common typo case (image/jpg, image/svg+xml) fails fast with a 400
  // instead of opening a transaction and returning a domain error.
  // S41 (FR-EM01): image/webp 추가(투명도 지원). JPEG 불허는 유지한다.
  @IsIn(['image/png', 'image/gif', 'image/webp'])
  mime!: 'image/png' | 'image/gif' | 'image/webp';

  @IsInt()
  @Min(1)
  @Max(256 * 1024)
  sizeBytes!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;
}
