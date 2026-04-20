/**
 * Task-016-C-4: ActiveUsersCollector unit test. Mocks Prisma $queryRaw
 * so we don't need a real DB, verifies the gauge is set for each
 * window with the value the DB returned.
 */
import { describe, expect, it, vi } from 'vitest';
import { Registry, Gauge } from 'prom-client';
import { ActiveUsersCollector } from '../../../src/observability/active-users.collector';

function makeMetrics() {
  const registry = new Registry();
  const activeUsers = new Gauge({
    name: 'qufox_active_users_test',
    help: 'test',
    labelNames: ['window'],
    registers: [registry],
  });
  return { registry, activeUsers };
}

describe('ActiveUsersCollector', () => {
  it('sets the gauge for each window using the DB result', async () => {
    const { activeUsers } = makeMetrics();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([
        { window: '1d', count: 3n },
        { window: '7d', count: 12n },
        { window: '30d', count: 27n },
      ]),
    };
    const collector = new ActiveUsersCollector(
      prisma as unknown as ActiveUsersCollector['prisma'],
      { activeUsers } as unknown as ActiveUsersCollector['metrics'],
    );
    const out = await collector.collectOnce();
    expect(out).toEqual({ '1d': 3, '7d': 12, '30d': 27 });

    // prom-client's Gauge exposes the current value by window label.
    const oneDay = await activeUsers.get();
    const byWindow = new Map<string, number>();
    for (const v of oneDay.values) byWindow.set(String(v.labels.window), v.value);
    expect(byWindow.get('1d')).toBe(3);
    expect(byWindow.get('7d')).toBe(12);
    expect(byWindow.get('30d')).toBe(27);
  });

  it('on Prisma error returns zeros without throwing (informational only)', async () => {
    const { activeUsers } = makeMetrics();
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const collector = new ActiveUsersCollector(
      prisma as unknown as ActiveUsersCollector['prisma'],
      { activeUsers } as unknown as ActiveUsersCollector['metrics'],
    );
    const out = await collector.collectOnce();
    expect(out).toEqual({ '1d': 0, '7d': 0, '30d': 0 });
  });
});
