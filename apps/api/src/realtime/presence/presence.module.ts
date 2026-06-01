import { Module } from '@nestjs/common';
import { PresenceService } from './presence.service';

/**
 * S27 (FR-P08/P12): PresenceService 를 독립 모듈로 분리한다.
 *
 * 멤버 목록 REST(WorkspacesModule)가 프레즌스를 bulkFor 단일 조회로 읽어야 하는데,
 * WorkspacesModule → RealtimeModule 직접 import 는 순환을 만든다
 * (Realtime → Channels → Workspaces). PresenceService 는 REDIS(전역 RedisModule)만
 * 의존하므로 게이트웨이 그래프와 분리해 이 작은 모듈로 빼고, RealtimeModule 과
 * WorkspacesModule 양쪽이 이 모듈만 import 하면 순환 없이 동일 인스턴스를 공유한다.
 */
@Module({
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
