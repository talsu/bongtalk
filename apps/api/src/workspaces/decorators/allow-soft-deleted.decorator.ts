import { SetMetadata } from '@nestjs/common';

/**
 * Opt-out marker for `WorkspaceMemberGuard`: when present, the guard still
 * injects `req.workspace` / `req.workspaceMember` but does NOT reject a
 * workspace whose `deletedAt` is set. Used only by the `restore` endpoint.
 */
export const ALLOW_SOFT_DELETED_KEY = 'allowSoftDeleted';
export const AllowSoftDeleted = () => SetMetadata(ALLOW_SOFT_DELETED_KEY, true);
