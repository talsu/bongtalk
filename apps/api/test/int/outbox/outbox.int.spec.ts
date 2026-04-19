/**
 * Outbox correctness tests — tx rollback, at-least-once delivery, SKIP LOCKED
 * under concurrent dispatchers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GenericContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';
import { OutboxService } from '../../../src/common/outbox/outbox.service';
import { OutboxDispatcher } from '../../../src/common/outbox/outbox.dispatcher';

let app: INestApplication | undefined;
let prisma: PrismaService;
let outbox: OutboxService;
let dispatcher: OutboxDispatcher;
let emitter: EventEmitter2;

beforeAll(async () => {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  const pg = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'qufox',
      POSTGRES_PASSWORD: 'qufox',
      POSTGRES_DB: 'qufox_outbox_int',
    })
    .withExposedPorts(5432)
    .start();

  const databaseUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_outbox_int?schema=public`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-at-least-32-characters';
  process.env.JWT_ISSUER = 'qufox';
  process.env.JWT_AUDIENCE = 'qufox-web';
  process.env.ACCESS_TOKEN_TTL = '900';
  process.env.REFRESH_TOKEN_TTL = '604800';
  process.env.CORS_ORIGINS = 'http://localhost:45173';
  process.env.NODE_ENV = 'test';
  process.env.ARGON2_MEMORY_KIB = '1024';
  process.env.ARGON2_TIME_COST = '1';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.OUTBOX_DISPATCH_INTERVAL_MS = '10_000'; // we drive ticks manually
  process.env.OUTBOX_BATCH_SIZE = '50';
  process.env.OUTBOX_MAX_ATTEMPTS = '10';

  const apiRoot = path.resolve(__dirname, '../../..');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  prisma = app.get(PrismaService);
  outbox = app.get(OutboxService);
  dispatcher = app.get(OutboxDispatcher);
  emitter = app.get(EventEmitter2);
  // Prevent the auto-poll from stealing rows during tests — we drive drain()
  // manually instead. pausePolling() leaves the dispatcher healthy for drain().
  dispatcher.pausePolling();
}, 240_000);

afterAll(async () => {
  await app?.close();
}, 60_000);

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await prisma.outboxEvent.deleteMany({});
});

describe('OutboxService.record', () => {
  it('is rolled back when the enclosing $transaction rolls back', async () => {
    const aggregateId = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.record(tx, {
          aggregateType: 'workspace',
          aggregateId,
          eventType: 'test.rollback',
          payload: { n: 1 },
        });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const rows = await prisma.outboxEvent.findMany({ where: { aggregateId } });
    expect(rows).toHaveLength(0);
  });

  it('persists when the transaction commits', async () => {
    const aggregateId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await outbox.record(tx, {
        aggregateType: 'workspace',
        aggregateId,
        eventType: 'test.commit',
        payload: { n: 2 },
      });
    });
    const rows = await prisma.outboxEvent.findMany({ where: { aggregateId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('test.commit');
    expect(rows[0].dispatchedAt).toBeNull();
  });
});

describe('OutboxDispatcher.drain', () => {
  it('dispatches undispatched events via EventEmitter2 and marks them', async () => {
    const received: Array<{ type: string; payload: unknown }> = [];
    const handler = (payload: unknown) =>
      received.push({ type: 'test.drain', payload });
    emitter.on('test.drain', handler);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await prisma.$transaction((tx) =>
        outbox.record(tx, {
          aggregateType: 'workspace',
          aggregateId: randomUUID(),
          eventType: 'test.drain',
          payload: { i },
        }),
      );
      ids.push(id);
    }

    const count = await dispatcher.drain();
    expect(count).toBe(3);
    expect(received).toHaveLength(3);

    const rows = await prisma.outboxEvent.findMany({ where: { id: { in: ids } } });
    for (const row of rows) expect(row.dispatchedAt).not.toBeNull();

    emitter.off('test.drain', handler);
  });

  it('does not re-emit an already-dispatched event on a second drain', async () => {
    const received: unknown[] = [];
    const handler = (payload: unknown) => received.push(payload);
    emitter.on('test.idempotent', handler);

    await prisma.$transaction((tx) =>
      outbox.record(tx, {
        aggregateType: 'workspace',
        aggregateId: randomUUID(),
        eventType: 'test.idempotent',
        payload: { v: 1 },
      }),
    );
    await dispatcher.drain();
    await dispatcher.drain();
    expect(received).toHaveLength(1);

    emitter.off('test.idempotent', handler);
  });

  it('two concurrent drain() calls do NOT double-dispatch (SKIP LOCKED)', async () => {
    const received: unknown[] = [];
    const handler = (payload: unknown) => received.push(payload);
    emitter.on('test.skiplock', handler);

    for (let i = 0; i < 20; i++) {
      await prisma.$transaction((tx) =>
        outbox.record(tx, {
          aggregateType: 'workspace',
          aggregateId: randomUUID(),
          eventType: 'test.skiplock',
          payload: { i },
        }),
      );
    }

    const [a, b] = await Promise.all([dispatcher.drain(), dispatcher.drain()]);
    expect(a + b).toBe(20);
    expect(received).toHaveLength(20);

    emitter.off('test.skiplock', handler);
  });
});

describe('OutboxDispatcher retry', () => {
  it('marks lastError + increments attempts when the handler throws, then retries next tick', async () => {
    let calls = 0;
    const handler = () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
    };
    emitter.on('test.retry', handler);

    const id = await prisma.$transaction((tx) =>
      outbox.record(tx, {
        aggregateType: 'workspace',
        aggregateId: randomUUID(),
        eventType: 'test.retry',
        payload: { v: 1 },
      }),
    );

    // 1st drain: handler throws → lastError set, attempts = 1, not dispatched
    await dispatcher.drain();
    let row = await prisma.outboxEvent.findUnique({ where: { id } });
    expect(row!.dispatchedAt).toBeNull();
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toMatch(/transient/);

    // 2nd drain: throw again
    await dispatcher.drain();
    row = await prisma.outboxEvent.findUnique({ where: { id } });
    expect(row!.attempts).toBe(2);

    // 3rd drain: succeed
    await dispatcher.drain();
    row = await prisma.outboxEvent.findUnique({ where: { id } });
    expect(row!.dispatchedAt).not.toBeNull();
    expect(row!.lastError).toBeNull();
    expect(calls).toBe(3);

    emitter.off('test.retry', handler);
  });
});
