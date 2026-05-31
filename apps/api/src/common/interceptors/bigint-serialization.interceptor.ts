import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { serializeBigInts, hasBigInt } from '@qufox/shared-types';

/**
 * ADR-11 · BigInt 직렬화 전역 인터셉터.
 *
 * 응답 DTO 에 실린 모든 BigInt(권한 마스크 allow/deny, message.seq 등)를
 * String 으로 치환합니다. JSON.stringify 는 BigInt 를 만나면
 * `TypeError: Do not know how to serialize a BigInt` 를 던지므로, 응답이
 * 직렬화되기 전에 본 인터셉터가 구조 순회로 변환합니다. number 정밀도
 * 한계(2^53)를 우회하므로 ADMINISTRATOR(1n<<63n) 비트도 손실 없이 전달됩니다.
 *
 * 핫패스 최적화: BigInt 가 없는 페이로드는 deep-copy 없이 원본을 그대로
 * 통과시킵니다(hasBigInt early-exit). 순환참조는 serializeBigInts/hasBigInt
 * 의 WeakSet 가드가 방어합니다.
 *
 * 등록: CommonModule 에서 APP_INTERCEPTOR 로 전역 등록되며, observability
 * 의 HttpMetricsInterceptor 와 독립적으로 응답 본문만 변환합니다.
 */
@Injectable()
export class BigIntSerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => (hasBigInt(data) ? serializeBigInts(data) : data)));
  }
}
