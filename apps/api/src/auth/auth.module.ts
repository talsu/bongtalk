import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { RateLimitService } from './services/rate-limit.service';
// S66 (D13 / FR-W05b): 이메일 인증 토큰 + Console stub 메일 발송 배선.
import { EmailVerificationService } from './services/email-verification.service';
import { ConsoleMailSender, MAIL_SENDER } from './services/mail.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { BetaInviteRequiredGuard } from './guards/beta-invite-required.guard';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret-at-least-32-chars-long',
        signOptions: {
          issuer: process.env.JWT_ISSUER ?? 'qufox',
          audience: process.env.JWT_AUDIENCE ?? 'qufox-web',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    RateLimitService,
    // S66 (D13 / FR-W05b): MailSender 는 인터페이스이므로 토큰(MAIL_SENDER)으로 구현
    // (ConsoleMailSender)을 주입한다. SMTP 어댑터 교체 시 이 한 줄만 바꾸면 된다.
    EmailVerificationService,
    { provide: MAIL_SENDER, useClass: ConsoleMailSender },
    JwtStrategy,
    BetaInviteRequiredGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [
    AuthService,
    TokenService,
    PasswordService,
    RateLimitService,
    EmailVerificationService,
    JwtModule,
  ],
})
export class AuthModule {}
