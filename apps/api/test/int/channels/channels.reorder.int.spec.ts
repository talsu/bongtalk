/**
 * Concurrent-reorder test: two admins fire simultaneous /move requests on the
 * same target. Expected: both complete HTTP-2xx, and the final `position`
 * set across the category is injective (no duplicates) so the UI ordering is
 * deterministic. Required for evals/tasks/008.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  ChIntEnv,
  ORIGIN,
  bearer,
  seedWorkspaceWithRoles,
  setupChIntEnv,
} from './helpers';

let env: ChIntEnv;
let seed: Awaited<ReturnType<typeof seedWorkspaceWithRoles>>;

beforeAll(async () => {
  env = await setupChIntEnv();
  seed = await seedWorkspaceWithRoles(env.baseUrl);
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('Concurrent reorder', () => {
  it('two admins reordering the same channel converge to distinct positions', async () => {
    const { workspaceId, admin, owner } = seed;
    // Seed 5 channels
    const channels: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels`)
        .set('origin', ORIGIN)
        .set(bearer(admin.accessToken))
        .send({ name: `reorder-${i}-${Date.now().toString(36)}`, type: 'TEXT' });
      channels.push(c.body.id);
    }

    // Two admins race the middle channel to different anchors.
    const target = channels[2];
    const [r1, r2] = await Promise.all([
      request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels/${target}/move`)
        .set('origin', ORIGIN)
        .set(bearer(admin.accessToken))
        .send({ beforeId: channels[0] }),
      request(env.baseUrl)
        .post(`/workspaces/${workspaceId}/channels/${target}/move`)
        .set('origin', ORIGIN)
        .set(bearer(owner.accessToken))
        .send({ afterId: channels[4] }),
    ]);
    // Both must succeed (last-write wins; no 500s).
    expect([r1.status, r2.status].every((s) => s === 201)).toBe(true);

    // Final state: every channel in this workspace has a distinct position.
    const rows = await env.prisma.channel.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, position: true },
    });
    const positions = rows.map((r) => r.position.toString());
    expect(new Set(positions).size).toBe(positions.length);
  }, 30_000);
});
