import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsModule } from './metrics/metrics.module';
import { HttpMetricsInterceptor } from './metrics/interceptors/http-metrics.interceptor';
import { ActiveUsersCollector } from './active-users.collector';

@Module({
  imports: [MetricsModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    // task-016-C-4: hourly DAU/WAU/MAU gauge refresher.
    ActiveUsersCollector,
  ],
  exports: [MetricsModule],
})
export class ObservabilityModule {}
