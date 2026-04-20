import type { WorkspaceRole } from '@qufox/shared-types';

/**
 * Maps a workspace role to a badge label for qf-badge --accent.
 *
 * OWNER / ADMIN get badges; MEMBER does not (most senders are members,
 * rendering a "MEMBER" badge on every row would be visual noise). The
 * mockup (index.html line 591) shows "MOD" next to ADMIN-tier users;
 * the shared-types enum currently has OWNER / ADMIN / MEMBER, so MOD
 * maps to ADMIN. If the role model later grows a distinct MOD tier,
 * only this helper changes.
 */
export function roleBadgeLabel(role: WorkspaceRole | null | undefined): string | null {
  if (role === 'OWNER') return 'OWNER';
  if (role === 'ADMIN') return 'MOD';
  return null;
}
