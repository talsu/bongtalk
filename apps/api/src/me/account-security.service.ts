import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChangeEmailResponse } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { PasswordService } from '../auth/services/password.service';
import { TokenService } from '../auth/services/token.service';
import { TwoFactorService } from '../auth/services/two-factor.service';
import { EmailVerificationService } from '../auth/services/email-verification.service';
import { MAIL_SENDER, type MailSender } from '../auth/services/mail.service';

/**
 * S77b (D14 / FR-PS-15): 자격증명 변경(비밀번호·이메일).
 *
 *   changePassword: 현재 비번 재확인(argon2 verify) → (SF3) 2FA 활성 시 TOTP 재확인 → 새 비번
 *     해싱 저장. 2FA 활성 시 현재 세션을 제외한 전 RefreshToken 을 revoke + 등록 이메일로 보안
 *     알림(Console stub).
 *   changeEmail:    현재 비번 재확인 → (SF2) 2FA 활성 시 TOTP 재확인 → 신규 이메일로 인증메일
 *     발송(EmailVerificationService 재사용). 확인 콜백은 OUT(S77c) — 발송까지만.
 *
 * 현재 비번 재확인 실패는 PASSWORD_INCORRECT(403) — 이미 인증된 세션의 재확인 거부라 로그인
 * 401(AUTH_INVALID_CREDENTIALS)과 구분한다.
 *
 * ★ SF2·SF3 (security HIGH-2·3) fix-forward: 2FA 활성 사용자는 비번/이메일 변경 시 TOTP 코드를
 *   필수로 재확인한다(누락 403 TOTP_CODE_REQUIRED · 불일치/재사용 403 TOTP_INVALID). 비번 단독
 *   으로 자격증명을 바꾸는 2FA 우회를 막는다(탈취된 세션 방어). 검증은 비번 확인 직후·변경 직전에
 *   수행한다.
 */
@Injectable()
export class AccountSecurityService {
  private readonly logger = new Logger(AccountSecurityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly twoFactor: TwoFactorService,
    private readonly emailVerification: EmailVerificationService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  /**
   * 본인 비밀번호 변경. 2FA 활성 시 TOTP 재확인(SF3) + 현재 세션 제외 전 세션 revoke + 보안 알림.
   *
   * RF2 (reviewer M2) fail-open 정책: currentFamilyId 가 null(쿠키 부재/회전/미해결)이면 "현재
   * 세션 제외 revoke" 가 현재 세션까지 끊을 위험이 있으므로, revoke 를 **생략하고** 보안 알림만
   * 보낸다(현재 사용 중 세션 보존 보장). 이는 의도된 fail-open 이다 — access token 만으로는
   * 세션 패밀리를 안정적으로 식별할 수 없고(stateless JWT), 잘못된 전체 revoke 로 사용자를
   * 강제 로그아웃시키는 쪽이 더 큰 가용성 손상이기 때문이다. familyId 가 해석되면 정상적으로
   * 현재 세션을 제외하고 전부 revoke 한다.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentFamilyId: string | null,
    totpCode?: string,
  ): Promise<void> {
    // 새 비번 정책(min 8 + 3 class) 검증 — 변경 전에 거부해 약한 비번 저장을 막는다.
    this.passwords.validateStrength(newPassword);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, email: true, totpEnabled: true },
    });
    if (!user) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'user not found');
    }
    const ok = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!ok) {
      throw new DomainError(ErrorCode.PASSWORD_INCORRECT, 'current password is incorrect');
    }

    // SF3: 2FA 활성 사용자는 TOTP 재확인이 통과해야 변경할 수 있다(미활성이면 no-op).
    await this.twoFactor.assertCredentialChangeTotp(userId, totpCode);

    const newHash = await this.passwords.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } });

    // FR-PS-15: 2FA 활성 사용자는 비번 변경 시 현재 세션을 제외한 전 세션을 강제 로그아웃하고
    // 등록 이메일로 보안 알림을 보낸다(탈취 대응 강화). 2FA 미활성은 세션 정리를 강제하지 않는다.
    if (user.totpEnabled) {
      if (currentFamilyId !== null) {
        await this.tokens.revokeAllExceptFamily(userId, currentFamilyId);
      } else {
        // RF2 fail-open: 현재 세션을 안정적으로 식별할 수 없어 전체 revoke 를 생략한다(현재
        // 세션 보존 보장). 보안 알림만 발송하고 감사 신호를 남긴다.
        this.logger.warn(
          JSON.stringify({
            event: 'account.change_password.revoke_skipped_no_family',
            userId,
          }),
        );
      }
      await this.mail.sendSecurityAlertEmail(user.email, 'password_changed');
    }
  }

  /** 본인 이메일 변경(인증메일 발송까지). 2FA 활성 시 TOTP 재확인(SF2). 확인 콜백은 OUT(S77c). */
  async changeEmail(
    userId: string,
    currentPassword: string,
    newEmail: string,
    totpCode?: string,
  ): Promise<ChangeEmailResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'user not found');
    }
    const ok = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!ok) {
      throw new DomainError(ErrorCode.PASSWORD_INCORRECT, 'current password is incorrect');
    }

    // SF2: 2FA 활성 사용자는 TOTP 재확인이 통과해야 이메일을 바꿀 수 있다(미활성이면 no-op).
    await this.twoFactor.assertCredentialChangeTotp(userId, totpCode);

    // 신규 이메일로 인증메일을 발송한다(EmailVerificationService 재사용 — 토큰 1행 발급 +
    // Console stub 으로 verifyUrl 출력). 확인 콜백은 OUT — 본 슬라이스는 발송까지만 완결한다.
    await this.emailVerification.issueAndSend(userId, newEmail);
    return { pendingEmail: newEmail };
  }
}
