import { Controller, Get, Param, ParseUUIDPipe, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { ChannelAccessByIdGuard } from '../attachments/guards/channel-access-by-id.guard';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { S3Service } from '../storage/s3.service';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { ALLOWED_IMAGE_MIME } from './og-image-fetcher';

/**
 * S60 fix (security HIGH-1 / HIGH-2 · perf SERIOUS / LOW-2): unfurl OG 이미지 프록시.
 *
 *   GET /links/embed-image/:embedId
 *
 * MessageEmbed.imageKey(MinIO object key)를 presigned URL 직접 노출 대신 백엔드 프록시
 * 뒤에서만 서빙한다. 매 요청 절차(attachment-proxy 선례 · presigned URL token-leak 우회
 * 방지 — ban/킥 직후 즉시 403/404 보장):
 *   (0) per-user rate-limit(embed:img:u:{userId} · 300/min) — 프록시 남용/스트리밍 폭주 차단.
 *   (1) MessageEmbed + 메시지/채널 조인 조회(없거나 imageKey 없으면 404).
 *   (2) suppress/삭제된 embed 는 404(억제된 카드의 이미지 노출 차단).
 *   (3) 채널 READ 재검증(ChannelAccessByIdGuard.requireRead — 매 요청 · 중립 404).
 *   (4) **public/private 모두 바이트 스트리밍 프록시로 통일**(presigned 302 redirect 제거).
 *       presigned credential 이 히스토리/Referer/캐시/로그로 새거나 ban 후 단명 TTL 동안
 *       접근 가능한 표면을 완전히 닫는다(security HIGH-1).
 *   (5) 응답 헤더:
 *       - Cache-Control: private, max-age=86400, immutable
 *         (imageKey 가 sha256 URL-주소화 불변이라 안전 · 브라우저 캐시 hit 으로 재요청·
 *          DB 폭발·이벤트루프 스트리밍 부담을 첫 로드로 한정 — perf SERIOUS).
 *       - X-Content-Type-Options: nosniff (MIME 스니핑 차단).
 *       - Content-Type: 저장된 contentType 을 ALLOWED_IMAGE_MIME 과 **재대조**해 통과한
 *         것만 그대로 쓰고, 불일치(과거 잘못 저장된 svg 등)면 404 — stored-XSS 방어
 *         (security MEDIUM-2).
 */
@UseGuards(JwtAuthGuard)
@Controller('links')
export class EmbedImageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channelAccess: ChannelAccessByIdGuard,
    private readonly s3: S3Service,
    private readonly rate: RateLimitService,
  ) {}

  @Get('embed-image/:embedId')
  async embedImage(
    @Param('embedId', new ParseUUIDPipe()) embedId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res() res: Response,
  ): Promise<void> {
    // (0) per-user rate-limit. 정상 사용(카드 이미지)에는 넉넉하되, 프록시 스캔/폭주 차단.
    await this.rate.enforce([{ key: `embed:img:u:${user.id}`, windowSec: 60, max: 300 }]);

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
    // (3) 매 요청 READ 재검증(ban/킥 직후 차단 · 중립 404).
    await this.channelAccess.requireRead(
      { id: channel.id, workspaceId: channel.workspaceId, isPrivate: channel.isPrivate },
      user.id,
    );

    // (4) public/private 모두 바이트 스트리밍(presigned 노출 0).
    const obj = await this.s3.getObjectStream(embed.imageKey);
    if (!obj) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'embed image object gone');
    }

    // (5) 저장된 contentType 을 허용목록과 재대조 — 불일치(과거 svg 등)면 404(stored-XSS 방어).
    const storedMime = (obj.contentType ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME[storedMime]) {
      if (obj.stream instanceof Readable) obj.stream.destroy();
      throw new DomainError(ErrorCode.NOT_FOUND, 'embed image not found');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    // imageKey 는 sha256 URL-주소화 불변 → 24h 브라우저 캐시(첫 로드만 스트리밍).
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.setHeader('Content-Type', storedMime);
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
