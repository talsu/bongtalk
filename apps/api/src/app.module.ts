import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { HealthController } from './health/health.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    PrismaModule,
    RedisModule,
    UsersModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [
    RealtimeGateway,
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
