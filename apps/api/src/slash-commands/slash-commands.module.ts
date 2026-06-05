import { Module } from '@nestjs/common';
import { SlashCommandController } from './slash-command.controller';
import { SlashCommandService } from './slash-command.service';
import { AuthModule } from '../auth/auth.module';

/**
 * S79 (D15 / FR-SC-01·02·03) — 슬래시 커맨드 모듈.
 *
 * AuthModule 은 RateLimitService(목록 60/min 게이트)와 JwtAuthGuard 를 제공한다.
 * PrismaModule 은 전역이라 별도 import 불필요(서비스가 PrismaService 주입).
 *
 * 본 슬라이스는 자동완성 + `/명령 ` 삽입까지만 다룬다 — 실행(POST execute)은 S80,
 * 커스텀 CRUD 는 S81 에서 이 모듈에 컨트롤러/서비스 메서드를 추가한다.
 */
@Module({
  imports: [AuthModule],
  controllers: [SlashCommandController],
  providers: [SlashCommandService],
  exports: [SlashCommandService],
})
export class SlashCommandsModule {}
