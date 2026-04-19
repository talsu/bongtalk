import 'reflect-metadata';
import { startOtel } from './observability/otel/otel-sdk';
// OTEL SDK MUST start before any Nest module imports so auto-instrumentation
// can monkey-patch `http`, `pg`, `ioredis` at require-time. Putting this call
// after the NestFactory import would register no-op hooks on already-loaded
// modules.
startOtel();
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { logger } from './common/logging/logger';
import { RedisIoAdapter } from './realtime/io-adapter';
import { assertProductionEnv } from './config/required-env';

function corsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function bootstrap(): Promise<void> {
  // Fail fast on misconfigured production env (e.g. missing WEB_URL) —
  // silently serving invite links with a localhost origin is worse than a
  // hard crash at container start.
  assertProductionEnv(process.env);

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  app.use(helmet());
  app.use(cookieParser());

  const origins = corsOrigins();
  app.enableCors({
    origin: origins.length > 0 ? origins : true,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  // OTEL SDK already started at the top of the file (before Nest import).

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  logger.info({ port }, 'qufox-api listening');
}

bootstrap().catch((err) => {
  logger.error({ err }, 'api bootstrap failed');
  process.exit(1);
});
