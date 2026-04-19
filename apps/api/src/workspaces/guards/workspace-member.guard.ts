import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import type { CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { ALLOW_SOFT_DELETED_KEY } from '../decorators/allow-soft-deleted.decorator';

/**
 * Attaches `req.workspace` and `req.workspaceMember` after verifying that the
 * authenticated user is a member of the workspace referenced by `:id` / `:wsId`.
 *
 * IDOR defence: when the workspace exists but the caller is NOT a member, we
 * respond **404 WORKSPACE_NOT_MEMBER** (never 403) so the guard never
 * distinguishes "doesn't exist" from "not your workspace" externally.
 *
 * Soft-delete invariant: by default, a workspace with `deletedAt` set is
 * treated as not found. Routes that legitimately target soft-deleted
 * workspaces (today: `POST /workspaces/:id/restore`) opt out via
 * `@AllowSoftDeleted()`.
 */
@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: CurrentUserPayload;
        params: Record<string, string>;
        workspace?: unknown;
        workspaceMember?: unknown;
      }
    >();

    if (!req.user) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'authentication required');
    }

    const workspaceId = req.params.id ?? req.params.wsId;
    if (!workspaceId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'workspace id path parameter missing',
      );
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, slug: true, ownerId: true, deletedAt: true },
    });
    if (!workspace) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }

    const allowSoftDeleted = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_SOFT_DELETED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (workspace.deletedAt && !allowSoftDeleted) {
      // Hide soft-deleted workspaces behind the same 404 we use for missing ones.
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }

    const member = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: req.user.id },
      },
      select: { role: true, userId: true, workspaceId: true },
    });
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'workspace not found');
    }

    req.workspace = workspace;
    req.workspaceMember = member;
    return true;
  }
}
