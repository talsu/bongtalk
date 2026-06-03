import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * S62 (D12 / FR-RM17): 감사 로그 서비스 전역 등록. @Global 이라 channel-access
 * (ADMINISTRATOR 우회 기록) · S63 모더레이션 컨트롤러 등 어디서든 import 없이
 * 주입한다. PrismaService 도 @Global 이라 추가 import 불필요.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
