/**
 * Deterministic user fixtures — uuid v5 with fixed namespace.
 * Do not import random uuid generators here.
 */
import { v5 as uuidv5 } from 'uuid';

const NS = '00000000-0000-0000-0000-000000000000';

export function makeUser(
  key: string,
  overrides: Partial<{ email: string; username: string }> = {},
) {
  return {
    id: uuidv5(`user:${key}`, NS),
    email: overrides.email ?? `${key}@qufox.dev`,
    username: overrides.username ?? key,
    createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
  };
}
