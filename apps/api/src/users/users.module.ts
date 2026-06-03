import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { MeDmPrivacyController } from './me-dm-privacy.controller';
import { MeSettingsController } from './me-settings.controller';

// S19 (FR-DM-12): MeDmPrivacyController 가 @UseGuards(JwtAuthGuard) 를 쓰지만
// AuthModule 을 import 하지 않는다 — AuthModule 이 이미 UsersModule 을 import 하므로
// (auth → users) 역방향 import 는 순환을 만든다. JwtAuthGuard 는 passport
// AuthGuard('jwt') 라서 전략 이름으로 런타임 해석되며, AuthModule 이 AppModule 에서
// 부팅될 때 전략이 전역 등록되므로 별도 import 없이 동작한다. PrismaService 는
// @Global PrismaModule 로 주입된다.
@Module({
  // S54 (D11 / FR-RS-13): MeSettingsController 도 동일 패턴(JwtAuthGuard 전역 전략 +
  // @Global PrismaModule 주입)으로 별도 AuthModule import 없이 동작한다.
  controllers: [MeDmPrivacyController, MeSettingsController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
