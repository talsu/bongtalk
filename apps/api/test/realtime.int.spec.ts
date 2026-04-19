/**
 * Integration test: boot NestJS with WS gateway, connect a Socket.IO client,
 * send "ping", expect "pong" event.
 *
 * Uses Testcontainers to spin up Redis + Postgres (reserved for future
 * adapter + Prisma wiring in later tasks).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { io, Socket } from 'socket.io-client';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { AppModule } from '../src/app.module';

let app: INestApplication | undefined;
let redisContainer: StartedTestContainer | undefined;
let pgContainer: StartedTestContainer | undefined;
let port = 0;

beforeAll(async () => {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  pgContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'qufox',
      POSTGRES_PASSWORD: 'qufox',
      POSTGRES_DB: 'qufox_int',
    })
    .withExposedPorts(5432)
    .start();

  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.DATABASE_URL = `postgresql://qufox:qufox@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/qufox_int?schema=public`;

  // Apply migrations so OutboxDispatcher's startup query against `OutboxEvent`
  // succeeds. Realtime doesn't need the other tables but sharing the setup
  // keeps the env coherent with the rest of the int suite.
  const apiRoot = path.resolve(__dirname, '..');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'pipe',
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0);
  const server = app.getHttpServer();
  port = (server.address() as { port: number }).port;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await redisContainer?.stop().catch(() => undefined);
  await pgContainer?.stop().catch(() => undefined);
}, 60_000);

describe('realtime gateway ping/pong', () => {
  it('responds with pong event + echo payload', async () => {
    const client: Socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
        client.on('connect', () => {
          clearTimeout(t);
          resolve();
        });
        client.on('connect_error', (err) => {
          clearTimeout(t);
          reject(err);
        });
      });

      const reply = await new Promise<unknown>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('pong timeout')), 8000);
        client.on('pong', (payload: unknown) => {
          clearTimeout(t);
          resolve(payload);
        });
        client.emit('ping', { hello: 'qufox' });
      });
      expect(reply).toEqual({ hello: 'qufox' });
    } finally {
      client.close();
    }
  }, 30_000);
});
