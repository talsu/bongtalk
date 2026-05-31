import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BigIntSerializationInterceptor } from './interceptors/bigint-serialization.interceptor';

/**
 * 전역 cross-cutting provider 묶음.
 *
 * ADR-11 BigInt 직렬화 인터셉터를 APP_INTERCEPTOR 로 전역 등록합니다.
 * @Global 이므로 AppModule 한 곳에서만 import 하면 전 모듈 응답 경로에
 * 적용됩니다. observability 의 HttpMetricsInterceptor 와는 등록 순서상
 * 독립적이며(메트릭은 타이밍만, 본 인터셉터는 본문만 변환) 상호 간섭이
 * 없습니다.
 */
@Global()
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: BigIntSerializationInterceptor }],
})
export class CommonModule {}
