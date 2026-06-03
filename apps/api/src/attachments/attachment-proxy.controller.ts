import { Controller, Get, Param, ParseUUIDPipe, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AttachmentsService } from './attachments.service';
import { ChannelAccessByIdGuard } from './guards/channel-access-by-id.guard';
import { requiresAttachmentDisposition } from './attachment-policy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { S3Service } from '../storage/s3.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S55 (D11 / FR-AM-17) — 첨부 download/thumbnail 프록시.
 *
 *   GET /attachments/:id/download   — 원본
 *   GET /attachments/:id/thumbnail  — 썸네일(processingStatus≠READY 면 202, 키 없으면 원본 폴백)
 *
 * 매 요청 절차(presigned URL 의 token-leak 우회 방지 — ban 직후 즉시 403 보장):
 *   (1) Attachment + finalizedAt 조회(미완료 404).
 *   (2) channel.isPrivate 를 DB 재조회(캐시 불가).
 *   (3) 멤버십 + READ 재검증(ChannelAccessByIdGuard.requireRead — 매 요청).
 *   (4) public(isPrivate=false) → 단명(60s) presignGet 302 redirect.
 *       private(isPrivate=true)  → API 가 바이트 스트리밍 프록시(@Res() pipe).
 *   (5) 위험 MIME(SVG/HTML/XML/JS) → Content-Disposition: attachment + nosniff
 *       (redirect 경로는 presign 서명에, 스트리밍 경로는 응답 헤더에 박는다).
 *
 * 기존 `/attachments/:id/download-url`(presign 반환, AttachmentsController)은 deprecated
 * 로 병존한다(클라이언트 마이그레이션 + 무회귀).
 */
@UseGuards(JwtAuthGuard)
@Controller('attachments')
export class AttachmentProxyController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly channelAccess: ChannelAccessByIdGuard,
    private readonly s3: S3Service,
  ) {}

  @Get(':id/download')
  async download(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res() res: Response,
  ): Promise<void> {
    const meta = await this.attachments.resolveForProxy(id);
    // 매 요청 READ 재검증(ban/킥 직후 403). private/public 무관하게 항상 검증한다.
    await this.channelAccess.requireRead(meta.channel, user.id);

    const effectiveMime = meta.storedMimeType ?? meta.mime;
    const forceAttachment = requiresAttachmentDisposition(effectiveMime);

    if (!meta.channel.isPrivate) {
      // public: 단명 presigned GET 302 redirect. 위험 MIME 은 서명에 disposition 박음.
      const url = await this.attachments.presignProxyGet(meta.storageKey, forceAttachment);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.redirect(302, url);
      return;
    }

    // private: 바이트 스트리밍 프록시(매 요청 재검증 완료된 상태). presigned URL 을 외부로
    // 노출하지 않는다.
    await this.streamObject(
      res,
      meta.storageKey,
      effectiveMime,
      meta.originalName,
      forceAttachment,
    );
  }

  @Get(':id/thumbnail')
  async thumbnail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res() res: Response,
  ): Promise<void> {
    const meta = await this.attachments.resolveForProxy(id);
    await this.channelAccess.requireRead(meta.channel, user.id);

    // 후처리 미완료 → 202(클라가 잠시 후 재시도). READY 인데 thumbnailKey 가 없으면
    // 원본으로 폴백한다(이미지 원본을 썸네일로 사용).
    if (meta.processingStatus !== 'READY') {
      res.status(202).json({ status: meta.processingStatus, message: 'thumbnail not ready' });
      return;
    }
    const key = meta.thumbnailKey ?? meta.storageKey;
    const effectiveMime = meta.storedMimeType ?? meta.mime;
    const forceAttachment = requiresAttachmentDisposition(effectiveMime);

    if (!meta.channel.isPrivate) {
      const url = await this.attachments.presignProxyGet(key, forceAttachment);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.redirect(302, url);
      return;
    }
    await this.streamObject(res, key, effectiveMime, meta.originalName, forceAttachment);
  }

  /**
   * private 채널 첨부의 바이트 스트리밍 프록시. getObjectStream → @Res() pipe. 위험
   * MIME 은 attachment disposition + nosniff. 스트림 에러는 헤더 전송 전이면 502, 이후면
   * 소켓 종료.
   */
  private async streamObject(
    res: Response,
    key: string,
    mime: string,
    originalName: string,
    forceAttachment: boolean,
  ): Promise<void> {
    const obj = await this.s3.getObjectStream(key);
    if (!obj) {
      throw new DomainError(ErrorCode.ATTACHMENT_NOT_FOUND, 'object not found in storage');
    }
    res.setHeader('Content-Type', obj.contentType ?? mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (obj.contentLength !== undefined) {
      res.setHeader('Content-Length', String(obj.contentLength));
    }
    // 위험 MIME 은 강제 다운로드. 그 외는 inline(이미지/비디오 미리보기 허용).
    const dispType = forceAttachment ? 'attachment' : 'inline';
    res.setHeader(
      'Content-Disposition',
      `${dispType}; filename="${sanitizeHeaderFilename(originalName)}"`,
    );
    obj.stream.on('error', () => {
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.end();
      }
    });
    obj.stream.pipe(res);
  }
}

/**
 * Content-Disposition filename 헤더에 안전한 ASCII 만 남긴다(헤더 인젝션/CR-LF 차단).
 * 비ASCII·따옴표·제어문자는 _ 로 치환한다. 빈 결과면 'file'.
 */
function sanitizeHeaderFilename(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return safe.length > 0 ? safe : 'file';
}
