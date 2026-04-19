import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HealthResponseSchema } from '@qufox/shared-types';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('api.fetchHealth', () => {
  it('parses a valid health response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'ok', version: '0.1.0', uptime: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const { fetchHealth } = await import('./api');
    const res = await fetchHealth();
    expect(HealthResponseSchema.parse(res).status).toBe('ok');
  });
});
