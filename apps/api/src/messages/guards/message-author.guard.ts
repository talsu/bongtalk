import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import type { CurrentUserPayload } from '../../auth/decorators/current-user.decorator';

/**
 * Loads `:msgId` into `req.message`, scoped to `:chid`. Ensures the caller is
 * the message author. Used by PATCH — editing is author-only by policy
 * (an owner can delete someone else's message but cannot rewrite it).
 *
 * The guard also loads the row so the controller / service never double-fetch.
 */
@Injectable()
export class MessageAuthorGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: CurrentUserPayload;
        params: Record<string, string>;
        message?: unknown;
      }
    >();

    if (!req.user) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'authentication required');
    }
    const channelId = req.params.chid;
    const msgId = req.params.msgId;
    if (!channelId || !msgId) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'channel / message id missing');
    }
    const row = await this.prisma.message.findFirst({
      where: { id: msgId, channelId },
      select: {
        id: true,
        channelId: true,
        authorId: true,
        content: true,
        deletedAt: true,
        createdAt: true,
      },
    });
    if (!row || row.deletedAt) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
    }
    if (row.authorId !== req.user.id) {
      throw new DomainError(ErrorCode.MESSAGE_NOT_AUTHOR, 'only the author can edit this message');
    }
    req.message = row;
    return true;
  }
}
