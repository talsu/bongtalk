import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLE_RANK, WorkspaceRole } from '@qufox/shared-types';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import type { Request } from 'express';
import type { CurrentMemberPayload } from '../decorators/current-member.decorator';

/**
 * Reads `@Roles(MIN)` metadata and compares it to the role injected by
 * `WorkspaceMemberGuard`. No DB access — relies on `req.workspaceMember`.
 *
 * If no @Roles metadata is present, the guard is a no-op (member access suffices).
 */
@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const minRole = this.reflector.getAllAndOverride<WorkspaceRole | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!minRole) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { workspaceMember?: CurrentMemberPayload }>();
    const member = req.workspaceMember;
    if (!member) {
      throw new DomainError(
        ErrorCode.WORKSPACE_NOT_MEMBER,
        'workspace membership not resolved',
      );
    }
    if (ROLE_RANK[member.role] < ROLE_RANK[minRole]) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        `requires ${minRole} or higher; you are ${member.role}`,
      );
    }
    return true;
  }
}
