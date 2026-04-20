import { IsInt, IsMimeType, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class PresignUploadDto {
  /** Client-generated uuid for idempotency. */
  @IsUUID()
  clientAttachmentId!: string;

  @IsUUID()
  channelId!: string;

  @IsMimeType()
  @Length(1, 127)
  mime!: string;

  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  sizeBytes!: number;

  @IsString()
  @Length(1, 255)
  originalName!: string;
}
