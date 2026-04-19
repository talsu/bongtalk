import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { HealthController } from '../src/health/health.controller';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('HealthController', () => {
  it('/healthz returns ok + version + uptime', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const ctrl = mod.get(HealthController);
    const res = ctrl.health();
    expect(res.status).toBe('ok');
    expect(typeof res.version).toBe('string');
    expect(typeof res.uptime).toBe('number');
  });

  it('/readyz returns ok when checks pass', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const ctrl = mod.get(HealthController);
    const res = await ctrl.ready();
    expect(res.status).toBe('ok');
    expect(res.checks.db).toBe(true);
    expect(res.checks.redis).toBe(true);
  });
});
