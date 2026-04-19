import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { HealthController } from './health/health.controller';
import { OutboxHealthIndicator } from './health/outbox-health.indicator';
import { RealtimeModule } from './realtime/realtime.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ChannelsModule } from './channels/channels.module';
import { MessagesModule } from './messages/messages.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    // wildcard: true enables `@OnEvent('message.*')` etc. in task-005's
    // realtime projection. The existing channel/workspace emitters use
    // exact event names so flipping this on is additive.
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    ObservabilityModule,
    PrismaModule,
    RedisModule,
    OutboxModule,
    UsersModule,
    AuthModule,
    WorkspacesModule,
    ChannelsModule,
    MessagesModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [OutboxHealthIndicator, { provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
