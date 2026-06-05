import { Inject, Injectable } from '@nestjs/common';
import type { ChangeEmailResponse } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { PasswordService } from '../auth/services/password.service';
import { TokenService } from '../auth/services/token.service';
import { EmailVerificationService } from '../auth/services/email-verification.service';
import { MAIL_SENDER, type MailSender } from '../auth/services/mail.service';

/**
 * S77b (D14 / FR-PS-15): 자격증명 변경(비밀번호·이메일).
 *
 *   changePassword: 현재 비번 재확인(argon2 verify) → 새 비번 해싱 저장. 2FA 활성 시 현재
 *     세션을 제외한 전 RefreshToken 을 revoke + 등록 이메일로 보안 알림(Console stub).
 *   changeEmail:    현재 비번 재확인 → 신규 이메일로 인증메일 발송(EmailVerificationService
 *     재사용). 확인 콜백은 OUT(S77c) — 발송까지만. 기존 이메일/인증상태는 그대로 둔다.
 *
 * 현재 비번 재확인 실패는 PASSWORD_INCORRECT(403) — 이미 인증된 세션의 재확인 거부라 로그인
 * 401(AUTH_INVALID_CREDENTIALS)과 구분한다.
 */
@Injectable()
export class AccountSecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly emailVerification: EmailVerificationService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  /** 본인 비밀번호 변경. 2FA 활성 시 현재 세션 제외 전 세션 revoke + 보안 알림. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentFamilyId: string | null,
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

    const newHash = await this.passwords.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } });

    // FR-PS-15: 2FA 활성 사용자는 비번 변경 시 현재 세션을 제외한 전 세션을 강제 로그아웃하고
    // 등록 이메일로 보안 알림을 보낸다(탈취 대응 강화). 2FA 미활성은 세션 정리를 강제하지 않는다.
    if (user.totpEnabled) {
      await this.tokens.revokeAllExceptFamily(userId, currentFamilyId);
      await this.mail.sendSecurityAlertEmail(user.email, 'password_changed');
    }
  }

  /** 본인 이메일 변경(인증메일 발송까지). 확인 콜백/실제 email 컬럼 전환은 OUT(S77c). */
  async changeEmail(
    userId: string,
    currentPassword: string,
    newEmail: string,
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

    // 신규 이메일로 인증메일을 발송한다(EmailVerificationService 재사용 — 토큰 1행 발급 +
    // Console stub 으로 verifyUrl 출력). 확인 콜백은 OUT — 본 슬라이스는 발송까지만 완결한다.
    await this.emailVerification.issueAndSend(userId, newEmail);
    return { pendingEmail: newEmail };
  }
}
