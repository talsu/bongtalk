/**
 * Shared Testcontainers + NestJS bootstrap for auth integration tests.
 * Each spec file calls setupAuthIntEnv() in a beforeAll block.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import cookieParser from 'cookie-parser';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';

export type AuthIntEnv = {
  app: INestApplication;
  prisma: PrismaService;
  baseUrl: string;
  stop: () => Promise<void>;
};

export async function setupAuthIntEnv(): Promise<AuthIntEnv> {
  // Ryuk (the testcontainers reaper) times out on Synology kernel 4.4 — we
  // stop containers explicitly in afterAll, so the reaper is unnecessary.
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  console.log('[int-setup] step=redis-start');
  const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  console.log('[int-setup] step=redis-up port=' + redis.getMappedPort(6379));
  const pg = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'qufox',
      POSTGRES_PASSWORD: 'qufox',
      POSTGRES_DB: 'qufox_auth_int',
    })
    .withExposedPorts(5432)
    .start();
  console.log('[int-setup] step=pg-up port=' + pg.getMappedPort(5432));

  const databaseUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_auth_int?schema=public`;
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-at-least-32-characters';
  process.env.JWT_ISSUER = 'qufox';
  process.env.JWT_AUDIENCE = 'qufox-web';
  process.env.ACCESS_TOKEN_TTL = '900';
  process.env.REFRESH_TOKEN_TTL = '604800';
  process.env.CORS_ORIGINS = 'http://localhost:45173';
  process.env.NODE_ENV = 'test';
  // Minimum argon2 cost to keep 16+ hashes in int tests under the 3-min budget.
  process.env.ARGON2_MEMORY_KIB = '1024';
  process.env.ARGON2_TIME_COST = '1';
  process.env.ARGON2_PARALLELISM = '1';

  // Run the existing Prisma migrations against this container.
  // apps/api root = test/int/auth/../../.. relative to this file.
  const apiRoot = path.resolve(__dirname, '../../..');
  console.log('[int-setup] step=migrate');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  console.log('[int-setup] step=migrated');

  console.log('[int-setup] step=compile-module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  console.log('[int-setup] step=create-app');
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useWebSocketAdapter(new IoAdapter(app));
  console.log('[int-setup] step=listen');
  await app.listen(0);
  console.log('[int-setup] step=listening');

  const addr = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const prisma = app.get(PrismaService);

  return {
    app,
    prisma,
    baseUrl,
    stop: async () => {
      await app.close();
      await redis.stop().catch(() => undefined);
      await pg.stop().catch(() => undefined);
    },
  };
}

export function pickCookie(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers['set-cookie'];
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const entry of list) {
    const first = entry.split(';')[0];
    if (first.startsWith(`${name}=`)) return first.substring(name.length + 1);
  }
  return null;
}

let redisGlob: StartedTestContainer | undefined;
let pgGlob: StartedTestContainer | undefined;
export { redisGlob, pgGlob };
