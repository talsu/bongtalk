import { SetMetadata } from '@nestjs/common';
import { WorkspaceRole } from '@qufox/shared-types';

export const ROLES_KEY = 'workspaceRoles';

/**
 * Marks a route as requiring *at least* the given workspace role
 * (seniority: OWNER > ADMIN > MEMBER). When combined with
 * `WorkspaceRoleGuard` the guard enforces `rank(member.role) >= rank(min)`.
 */
export const Roles = (min: WorkspaceRole) => SetMetadata(ROLES_KEY, min);
