import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class PresignEmojiUploadDto {
  @Matches(/^[a-z0-9_]{2,32}$/)
  name!: string;

  // task-037 reviewer MED-2: enum-restrict at the DTO layer so the
  // common typo case (image/jpg, image/svg+xml) fails fast with a 400
  // instead of opening a transaction and returning a 415.
  @IsIn(['image/png', 'image/gif'])
  mime!: 'image/png' | 'image/gif';

  @IsInt()
  @Min(1)
  @Max(256 * 1024)
  sizeBytes!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;
}
