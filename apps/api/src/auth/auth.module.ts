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
// AUTH-3 (PRD D18 §5 / FR-AUTH-40~44): 비밀번호 재설정 토큰 발급/검증/소모.
import { PasswordResetService } from './services/password-reset.service';
import { MAIL_SENDER } from './services/mail.service';
// feat(mail): SMTP2GO 실발송 어댑터 + SMTP_HOST 유무로 Smtp/Console 선택하는 팩토리.
import { createMailSender } from './services/mail-sender.factory';
// S77b (D14 / FR-PS-15): AES-256-GCM 암호화 + TOTP 2FA 서비스.
import { CryptoService } from './services/crypto.service';
import { TwoFactorService } from './services/two-factor.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { BetaInviteRequiredGuard } from './guards/beta-invite-required.guard';
// 071-M0 C12: e2e 테스트 스택 전용 이메일 인증 훅 — E2E_TEST_HOOKS=1 일 때만 등록.
import { E2eTestHooksController } from './e2e-test-hooks.controller';
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
  // E2E_TEST_HOOKS=1(테스트 compose 한정) 일 때만 훅 컨트롤러를 라우팅에 올린다 —
  // prod/dev 환경에는 라우트 자체가 존재하지 않는다(컨트롤러 내부 2차 가드 별도).
  controllers: [
    AuthController,
    ...(process.env.E2E_TEST_HOOKS === '1' ? [E2eTestHooksController] : []),
  ],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    RateLimitService,
    // S66 (D13 / FR-W05b): MailSender 는 인터페이스이므로 토큰(MAIL_SENDER)으로 구현을 주입한다.
    // feat(mail): 구현 선택은 createMailSender 팩토리 한 곳에 모았다(SMTP_HOST 유무로 분기).
    EmailVerificationService,
    // AUTH-3 (PRD D18 §5 / FR-AUTH-40~44): 비밀번호 재설정 토큰 발급/검증/소모.
    PasswordResetService,
    // feat(mail): SMTP_HOST 설정 시 SmtpMailSender(SMTP2GO 실발송), 비면 ConsoleMailSender
    // 폴백(dev/test). RateLimitService 가 같은 모듈에 있어 inject 가능(전역 발송 상한용).
    {
      provide: MAIL_SENDER,
      useFactory: (rate: RateLimitService) => createMailSender(rate),
      inject: [RateLimitService],
    },
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
