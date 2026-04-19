/**
 * Workspace test fixtures.
 * Pure factory functions — actual DB seeding lives in the int-test helpers.
 */
import { randomUUID } from 'node:crypto';

export function makeWorkspaceInput(over: Partial<{ name: string; slug: string; description: string }> = {}) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 999)}`;
  return {
    name: over.name ?? `Acme ${stamp}`,
    slug: over.slug ?? `acme-${stamp.slice(-8)}`.toLowerCase(),
    description: over.description,
  };
}

export function makeInviteInput(over: Partial<{ expiresAt: string; maxUses: number }> = {}) {
  return {
    expiresAt: over.expiresAt,
    maxUses: over.maxUses ?? 3,
  };
}

export type SeededRoles = {
  ownerId: string;
  adminId: string;
  memberId: string;
  outsiderId: string;
  workspaceId: string;
};
