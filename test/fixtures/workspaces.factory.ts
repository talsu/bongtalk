import { v5 as uuidv5 } from 'uuid';

const NS = '00000000-0000-0000-0000-000000000000';

export function makeWorkspace(key: string, ownerId: string) {
  return {
    id: uuidv5(`workspace:${key}`, NS),
    name: key.charAt(0).toUpperCase() + key.slice(1),
    slug: key,
    ownerId,
    createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
  };
}
