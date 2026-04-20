import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * Task-016-C-2: closed-beta signup gate.
 *
 * BETA_INVITE_REQUIRED=true → POST /auth/signup must include a
 *   `inviteCode` in the body; guard validates it exists, is not
 *   revoked, has not expired, and still has uses remaining. A valid
 *   code still does NOT join the user to the workspace — the signup
 *   completes, then the existing `/invites/:code/accept` flow runs.
 *
 * Unset / false → guard is a no-op (dev/test default). Boot-time
 * assert in main.ts logs a WARN when NODE_ENV=production and the
 * flag isn't explicitly `true`.
 */
@Injectable()
export class BetaInviteRequiredGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (process.env.BETA_INVITE_REQUIRED !== 'true') return true;
    const req = ctx.switchToHttp().getRequest<Request & { body?: { inviteCode?: string } }>();
    const code = typeof req.body?.inviteCode === 'string' ? req.body.inviteCode.trim() : '';
    if (!code) {
      throw new DomainError(
        ErrorCode.BETA_INVITE_REQUIRED,
        'closed beta — a valid invite link is required to sign up',
      );
    }
    const invite = await this.prisma.invite.findUnique({
      where: { code },
      select: {
        revokedAt: true,
        expiresAt: true,
        maxUses: true,
        usedCount: true,
      },
    });
    if (!invite || invite.revokedAt) {
      throw new DomainError(
        ErrorCode.BETA_INVITE_REQUIRED,
        'invite link is invalid or has been revoked',
      );
    }
    if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(ErrorCode.BETA_INVITE_REQUIRED, 'invite link has expired');
    }
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      throw new DomainError(ErrorCode.BETA_INVITE_REQUIRED, 'invite link has no uses remaining');
    }
    return true;
  }
}
