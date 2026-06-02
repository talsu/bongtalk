import { Module } from '@nestjs/common';
import { MeNotificationBadgesService } from './me-notification-badges.service';

/**
 * S47 (D06 / FR-MN-14/20): 서버 단위 배지 집계 서비스(isMuted 제외)를 단일
 * 출처로 노출하는 경량 모듈. PrismaModule 이 @Global 이라 별도 import 가 없고,
 * MeModule(REST `GET /me/notification-badges`)과 RealtimeModule(WS
 * `notification:badge_update` emit)이 둘 다 이 모듈을 import 해 **같은 집계
 * 로직 단일 인스턴스**를 공유한다. MeModule ↔ RealtimeModule 순환을 피하려고
 * 서비스를 독립 모듈로 떼어낸다(MeModule 이 RealtimeModule 을 import 하므로
 * 역방향 import 금지).
 */
@Module({
  providers: [MeNotificationBadgesService],
  exports: [MeNotificationBadgesService],
})
export class MeNotificationBadgesModule {}
