import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { HealthController } from '../src/health/health.controller';
import { OutboxHealthIndicator } from '../src/health/outbox-health.indicator';
import { PrismaService } from '../src/prisma/prisma.module';
import { REDIS } from '../src/redis/redis.module';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const prismaStub = { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) };
const redisStub = { ping: vi.fn(async () => 'PONG') };
// task-020-A: OutboxHealthIndicator.check() now returns { ok, state,
// reason? } where state ∈ healthy / idle / stalled.
const outboxOk = { check: vi.fn(async () => ({ ok: true, state: 'healthy' })) };
const outboxIdle = { check: vi.fn(async () => ({ ok: true, state: 'idle' })) };
const outboxStalled = {
  check: vi.fn(async () => ({ ok: false, state: 'stalled', reason: 'stalled (42s)' })),
};

function mockRes() {
  let status = 200;
  return {
    res: {
      status(code: number) {
        status = code;
        return this;
      },
    },
    get status() {
      return status;
    },
  };
}

describe('HealthController', () => {
  it('/healthz returns ok + version + uptime', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        { provide: REDIS, useValue: redisStub },
        { provide: OutboxHealthIndicator, useValue: outboxOk },
      ],
    }).compile();
    const ctrl = mod.get(HealthController);
    const res = ctrl.health();
    expect(res.status).toBe('ok');
    expect(typeof res.version).toBe('string');
    expect(typeof res.uptime).toBe('number');
  });

  it('/readyz returns ok when all checks pass', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        { provide: REDIS, useValue: redisStub },
        { provide: OutboxHealthIndicator, useValue: outboxOk },
      ],
    }).compile();
    const m = mockRes();
    const res = await mod.get(HealthController).ready(m.res as never);
    expect(res.status).toBe('ok');
    expect(res.checks.db).toBe('ok');
    expect(res.checks.redis).toBe('ok');
    expect(res.checks.outbox).toBe('ok');
    expect(m.status).toBe(200);
  });

  it('/readyz returns degraded 503 when redis is down', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        {
          provide: REDIS,
          useValue: {
            ping: vi.fn(async () => {
              throw new Error('down');
            }),
          },
        },
        { provide: OutboxHealthIndicator, useValue: outboxOk },
      ],
    }).compile();
    const m = mockRes();
    const res = await mod.get(HealthController).ready(m.res as never);
    expect(res.status).toBe('degraded');
    expect(res.checks.redis).toBe('fail');
    expect(m.status).toBe(503);
  });

  it('/readyz stays 200 when outbox is idle (task-020-A: empty backlog, quiet dispatcher)', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        { provide: REDIS, useValue: redisStub },
        { provide: OutboxHealthIndicator, useValue: outboxIdle },
      ],
    }).compile();
    const m = mockRes();
    const res = await mod.get(HealthController).ready(m.res as never);
    expect(res.status).toBe('ok');
    expect(res.checks.outbox).toBe('idle');
    expect(m.status).toBe(200);
  });

  it('/readyz reports outbox stalled with reason', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        { provide: REDIS, useValue: redisStub },
        { provide: OutboxHealthIndicator, useValue: outboxStalled },
      ],
    }).compile();
    const m = mockRes();
    const res = await mod.get(HealthController).ready(m.res as never);
    expect(res.status).toBe('degraded');
    expect(res.checks.outbox).toBe('stalled');
    expect(res.details?.outbox).toContain('stalled');
    expect(m.status).toBe(503);
  });
});
