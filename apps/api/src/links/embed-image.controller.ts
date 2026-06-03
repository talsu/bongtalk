import { Controller, Get, Param, ParseUUIDPipe, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { ChannelAccessByIdGuard } from '../attachments/guards/channel-access-by-id.guard';
import { S3Service } from '../storage/s3.service';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/** S60 (FR-RC21): embed 이미지 프록시 302 redirect 의 단명 presigned GET TTL(초). */
const EMBED_PROXY_REDIRECT_TTL_SEC = 60;

/**
 * S60 (D11 / FR-RC21 · FR-AM-14): unfurl OG 이미지 프록시.
 *
 *   GET /links/embed-image/:embedId
 *
 * MessageEmbed.imageKey(MinIO object key)를 presigned URL 직접 노출 대신 백엔드 프록시
 * 뒤에서만 서빙한다. 매 요청 절차(attachment-proxy 선례 · presigned URL token-leak 우회
 * 방지 — ban/킥 직후 즉시 403 보장):
 *   (1) MessageEmbed + 메시지/채널 조인 조회(없거나 imageKey 없으면 404).
 *   (2) suppress/삭제된 embed 는 404(억제된 카드의 이미지 노출 차단).
 *   (3) 채널 READ 재검증(ChannelAccessByIdGuard.requireRead — 매 요청).
 *   (4) public(isPrivate=false) → 단명(60s) presignGet 302 redirect + nosniff.
 *       private(isPrivate=true)  → API 가 바이트 스트리밍 프록시(presigned URL 비노출).
 *   (5) 항상 X-Content-Type-Options: nosniff 를 박는다(MIME 스니핑 차단).
 *
 * 이미지 자체는 OgImageFetcher 가 저장 시 image/* MIME 만 허용했으므로(svg 제외)
 * inline 노출이 안전하다(stored-XSS 표면 닫힘).
 */
@UseGuards(JwtAuthGuard)
@Controller('links')
export class EmbedImageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessByIdGuard,
    private readonly s3: S3Service,
  ) {}

  @Get('embed-image/:embedId')
  async embedImage(
    @Param('embedId', new ParseUUIDPipe()) embedId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res() res: Response,
  ): Promise<void> {
    // (1) embed + 메시지/채널 조인. select 로 최소 필드만.
    const embed = await this.prisma.messageEmbed.findUnique({
      where: { id: embedId },
      select: {
        imageKey: true,
        suppressedAt: true,
        message: {
          select: {
            deletedAt: true,
            channel: {
              select: { id: true, workspaceId: true, isPrivate: true, deletedAt: true },
            },
          },
        },
      },
    });
    if (!embed || !embed.imageKey) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'embed image not found');
    }
    // (2) suppress/삭제된 embed·메시지·채널은 노출 차단.
    if (
      embed.suppressedAt !== null ||
      embed.message.deletedAt !== null ||
      embed.message.channel.deletedAt !== null
    ) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'embed image not found');
    }
    const channel = embed.message.channel;
    // (3) 매 요청 READ 재검증(ban/킥 직후 403).
    await this.channelAccess.requireRead(
      { id: channel.id, workspaceId: channel.workspaceId, isPrivate: channel.isPrivate },
      user.id,
    );

    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!channel.isPrivate) {
      // public: 단명 presigned GET 302 redirect.
      const url = await this.s3.presignGet(embed.imageKey, {
        expiresIn: EMBED_PROXY_REDIRECT_TTL_SEC,
      });
      res.redirect(302, url);
      return;
    }

    // private: 바이트 스트리밍 프록시(presigned URL 비노출).
    const obj = await this.s3.getObjectStream(embed.imageKey);
    if (!obj) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'embed image object gone');
    }
    res.setHeader('Content-Type', obj.contentType ?? 'application/octet-stream');
    if (obj.contentLength !== undefined) {
      res.setHeader('Content-Length', String(obj.contentLength));
    }
    res.setHeader('Content-Disposition', 'inline');
    try {
      await pipeline(obj.stream, res);
    } catch {
      if (!res.headersSent) res.status(502).end();
    }
  }
}
