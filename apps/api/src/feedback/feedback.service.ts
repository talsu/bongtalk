import { Injectable } from '@nestjs/common';
import { FeedbackCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

const MAX_CONTENT_LEN = 2000;

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(args: {
    userId: string;
    workspaceId: string | null;
    category: FeedbackCategory;
    content: string;
    page: string | null;
    userAgent: string | null;
  }): Promise<{ id: string; createdAt: string }> {
    const trimmed = args.content.trim();
    if (trimmed.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'feedback content is empty');
    }
    if (trimmed.length > MAX_CONTENT_LEN) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        `feedback content exceeds ${MAX_CONTENT_LEN} chars`,
      );
    }
    const row = await this.prisma.feedback.create({
      data: {
        userId: args.userId,
        workspaceId: args.workspaceId ?? undefined,
        category: args.category,
        content: trimmed,
        page: args.page,
        userAgent: args.userAgent,
      },
      select: { id: true, createdAt: true },
    });
    return { id: row.id, createdAt: row.createdAt.toISOString() };
  }
}
