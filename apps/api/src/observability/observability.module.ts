import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsModule } from './metrics/metrics.module';
import { HttpMetricsInterceptor } from './metrics/interceptors/http-metrics.interceptor';

@Module({
  imports: [MetricsModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor }],
  exports: [MetricsModule],
})
export class ObservabilityModule {}
