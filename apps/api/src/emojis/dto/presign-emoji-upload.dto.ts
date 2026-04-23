import { IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class PresignEmojiUploadDto {
  @Matches(/^[a-z0-9_]{2,32}$/)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(127)
  mime!: string;

  @IsInt()
  @Min(1)
  @Max(256 * 1024)
  sizeBytes!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;
}
