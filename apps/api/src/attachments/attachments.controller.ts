import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { ChannelAccessByIdGuard } from './guards/channel-access-by-id.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * Task-012-B + E. Attachment upload + download endpoints. ACL is
 * inline here rather than in a guard because each endpoint needs a
 * different permission bit (UPLOAD_ATTACHMENT on presign/finalize,
 * READ on download).
 */
@UseGuards(JwtAuthGuard)
@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessByIdGuard,
  ) {}

  @Post('presign-upload')
  async presign(@CurrentUser() user: CurrentUserPayload, @Body() body: PresignUploadDto) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: body.channelId },
      select: { id: true, workspaceId: true, isPrivate: true, archivedAt: true, deletedAt: true },
    });
    if (!channel || channel.deletedAt) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
    }
    if (channel.archivedAt) {
      throw new DomainError(ErrorCode.CHANNEL_ARCHIVED, 'channel is archived');
    }
    // Task-012-E: ACL is checked via the shared helper. The caller
    // must have UPLOAD_ATTACHMENT bit on the effective mask for this
    // channel. Private-channel non-members fail here.
    await this.channelAccess.requireUpload(channel, user.id);

    return this.attachments.presignUpload({
      clientAttachmentId: body.clientAttachmentId,
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      uploaderId: user.id,
      mime: body.mime,
      sizeBytes: body.sizeBytes,
      originalName: body.originalName,
    });
  }

  @Post(':id/finalize')
  @HttpCode(204)
  async finalize(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    await this.attachments.finalize(id, user.id);
  }

  @Get(':id/download-url')
  async downloadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const att = await this.attachments.findById(id);
    if (!att || !att.finalizedAt) {
      throw new DomainError(ErrorCode.ATTACHMENT_NOT_FOUND, 'attachment not ready');
    }
    const channel = await this.prisma.channel.findUnique({
      where: { id: att.channelId },
      select: { id: true, workspaceId: true, isPrivate: true, archivedAt: true, deletedAt: true },
    });
    if (!channel || channel.deletedAt) {
      throw new DomainError(ErrorCode.ATTACHMENT_NOT_FOUND, 'attachment channel gone');
    }
    // Task-012-E: READ bit at download time, not at presign time. If
    // the caller is removed from the channel between presign and
    // download, the presigned PUT already ran but subsequent download
    // attempts are 403 — the bytes are on disk but we gate access.
    // Token-leak is still a risk for URLs that have already issued
    // (documented in the runbook).
    await this.channelAccess.requireRead(channel, user.id);

    return this.attachments.presignDownload(id);
  }
}
