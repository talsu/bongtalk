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
// S77b (D14 / FR-PS-15): AES-256-GCM 암호화 + TOTP 2FA 서비스.
import { CryptoService } from './services/crypto.service';
import { TwoFactorService } from './services/two-factor.service';
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
    // S77b (D14 / FR-PS-15): TOTP 2FA 시크릿 암호화 + setup/verify/disable 로직.
    CryptoService,
    TwoFactorService,
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
    // S77b (D14 / FR-PS-15): MeModule 의 2FA/세션/자격증명 컨트롤러가 주입한다.
    CryptoService,
    TwoFactorService,
    // S68 (D13 / FR-W04 · Fork B): WorkspacesModule 의 PendingInvitesService 가 초대
    // 메일 발송에 MailSender 를 주입하므로 토큰을 export 한다(ConsoleMailSender 단일 출처).
    MAIL_SENDER,
    JwtModule,
  ],
})
export class AuthModule {}
