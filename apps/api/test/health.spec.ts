import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { HealthController } from '../src/health/health.controller';
import { PrismaService } from '../src/prisma/prisma.module';
import { REDIS } from '../src/redis/redis.module';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const prismaStub = { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) };
const redisStub = { ping: vi.fn(async () => 'PONG') };

describe('HealthController', () => {
  it('/healthz returns ok + version + uptime', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        { provide: REDIS, useValue: redisStub },
      ],
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
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        { provide: REDIS, useValue: redisStub },
      ],
    }).compile();
    const ctrl = mod.get(HealthController);
    const res = await ctrl.ready();
    expect(res.status).toBe('ok');
    expect(res.checks.db).toBe(true);
    expect(res.checks.redis).toBe(true);
  });

  it('/readyz returns degraded when redis is down', async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        { provide: REDIS, useValue: { ping: vi.fn(async () => { throw new Error('down'); }) } },
      ],
    }).compile();
    const res = await mod.get(HealthController).ready();
    expect(res.status).toBe('degraded');
    expect(res.checks.redis).toBe(false);
  });
});
