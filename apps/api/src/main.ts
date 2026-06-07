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

  // task-016-C-2: closed-beta signup gate. Default-ON isn't safe to
  // assume (dev/test explicitly disable), so production without a
  // `true` here gets a WARN line — not a crash, because a legit
  // public-demo deployment may want signup open.
  if (process.env.NODE_ENV === 'production' && process.env.BETA_INVITE_REQUIRED !== 'true') {
    logger.warn(
      { betaInviteRequired: process.env.BETA_INVITE_REQUIRED ?? '<unset>' },
      'BETA_INVITE_REQUIRED is not `true` in production — /auth/signup is open to anyone with the URL. Set BETA_INVITE_REQUIRED=true in .env.prod unless this is intentional.',
    );
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // S67 fix-forward (security HIGH): Express trust proxy.
  // prod 토폴로지는 qufox.com → nginx-proxy-1 → api 의 *단일* nginx 홉이므로 값은 `1`.
  // 이게 없으면 Express 가 socket peer(=nginx 내부 IP, 고정) 를 req.ip 로 쓰고, 그러면
  // 모든 per-IP rate-limit(login/signup/verify-email[S66]/invite preview·accept)이 단일
  // 전역 버킷을 공유해 실효를 잃는다. trust proxy=1 이면 X-Forwarded-For 의 *오른쪽에서
  // 1홉* 을 신뢰해 실제 클라이언트 IP 를 복원한다.
  // 주의: 홉 수가 정확해야 한다 — 홉 수보다 큰 값을 주면 클라이언트가 XFF 를 스푸핑해
  // rate-limit 을 우회할 수 있고, 작으면 다시 내부 IP 로 폴백한다. nginx 체인이 바뀌면
  // (예: CDN/추가 프록시 도입) 이 값을 새 홉 수에 맞춰 조정해야 한다.
  // dev/test 는 프록시가 없어 XFF 가 없으므로 socket IP 가 그대로 쓰여 무해하다.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

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

  // S88b fix-forward (F3 / HIGH ops): SIGTERM/SIGINT 시 Nest 의 lifecycle 훅
  // (onModuleDestroy / onApplicationShutdown)을 구동한다. 이게 없으면 @nestjs/bullmq 의
  // WorkerHost.onApplicationShutdown(worker.close — in-flight 잡 drain)이 호출되지 않아,
  // 배포 rollout(009 stack)의 컨테이너 recreate(docker stop → SIGTERM) 시점에 처리 중이던
  // BullMQ 잡(mention-broadcast/reminder/unfurl/push/temp-evict/onboarding-welcome 전 큐
  // 공통)이 mid-flight 로 끊긴다. mention-broadcast 는 MentionRecord 멱등(ON CONFLICT)이
  // 있어 재처리 안전하지만, drain 으로 진행 중 잡을 우아하게 마치면 재시도 노이즈/지연이
  // 준다. enableShutdownHooks 는 부작용이 없다 — 기존 onModuleDestroy 훅(io-adapter 등)도
  // 정상 동작하며, 미등록 시에는 no-op 이다.
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  logger.info({ port }, 'qufox-api listening');
}

bootstrap().catch((err) => {
  logger.error({ err }, 'api bootstrap failed');
  process.exit(1);
});
