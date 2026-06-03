import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CompleteUploadRequestSchema, UploadUrlRequestSchema } from '@qufox/shared-types';
import { AttachmentUploadService } from './attachment-upload.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S54 (D11 / FR-AM-03) — 채널 nested 첨부 업로드(presigned 3단계).
 *
 *   POST /workspaces/:id/channels/:chid/attachments/upload-url
 *   POST /workspaces/:id/channels/:chid/attachments/complete
 *
 * 채널 라우팅 컨벤션(`workspaces/:id/channels/:chid/...`)을 따른다. ACL/검증/세션은
 * AttachmentUploadService 가 담당한다(컨트롤러는 Zod 형태 검증 + 위임만). 기존
 * `/attachments/*` 라우트(AttachmentsController)는 deprecated 로 병존한다.
 */
@UseGuards(JwtAuthGuard)
@Controller('workspaces/:id/channels/:chid/attachments')
export class ChannelAttachmentsController {
  constructor(private readonly uploads: AttachmentUploadService) {}

  @Post('upload-url')
  async uploadUrl(
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = UploadUrlRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.uploads.createUploadUrl(user.id, channelId, parsed.data, new Date());
  }

  @Post('complete')
  @HttpCode(201)
  async complete(
    @Param('chid', new ParseUUIDPipe()) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    const parsed = CompleteUploadRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.uploads.complete(
      user.id,
      channelId,
      {
        messageId: parsed.data.messageId,
        targetChannelId: parsed.data.targetChannelId,
        sessions: parsed.data.sessions,
      },
      new Date(),
    );
  }
}
