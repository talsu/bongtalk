import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  PASSWORD_RESET_RESEND_COOLDOWN_SEC,
  PASSWORD_RESET_TOKEN_TTL_SEC,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { REDIS } from '../../redis/redis.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { MAIL_SENDER, type MailSender } from './mail.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-40~44): 비밀번호 재설정(미인증/비로그인) 토큰 발급/검증/소모.
 *
 * EmailVerificationService 를 미러링하되 두 가지가 다르다:
 *   ① raw 토큰(uuid)을 평문 저장하지 않고 sha256(token) 해시만 PasswordResetToken.tokenHash
 *      에 저장한다(invite tokenHash 패턴 — DB 유출 시 토큰 역산 방지). 검증 시 들어온 raw 토큰을
 *      같은 sha256 으로 해시해 @unique 인덱스로 O(1) 조회한다.
 *   ② TTL 이 24h 가 아닌 1h(발급+1h). 재설정은 즉시 사용을 전제하므로 짧게 둔다.
 *
 * forgot-password 는 계정 열거 방어로 **항상 200** 이며, 사용자가 존재하고 활성일 때만 토큰을
 * 발급하고 메일을 보낸다. IP rate-limit(컨트롤러)과 이메일당 쿨다운(여기 Redis 키 NX)을 둔다.
 *
 * reset-password 는 토큰 유효성(형식→조회→미사용→미만료)을 검증하고, 단일 tx CAS 로 1회 소모
 * (usedAt)하면서 argon2 재해싱(PasswordService 재사용)으로 비밀번호를 교체한다. 성공 시 해당
 * 사용자의 전 RefreshToken 을 revoke 한다(전 기기 강제 로그아웃 · FR-AUTH-42).
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  /** raw 토큰 → sha256 hex(저장/조회 공통 해시 · TokenService.hashToken 과 동일 알고리즘). */
  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private resetUrl(token: string): string {
    const base = (process.env.WEB_URL ?? 'http://localhost:45173').replace(/\/$/, '');
    return `${base}/reset-password?token=${token}`;
  }

  /**
   * POST /auth/forgot-password. 계정 열거 방어로 **항상 정상 반환**(void)한다. 사용자가 존재하고
   * 활성(비활성화 아님)일 때만 토큰 1행을 발급하고 재설정 메일을 보낸다. 이메일당 쿨다운(기본
   * 60초)을 Redis NX 로 원자 점유해, 같은 주소로의 메일 폭탄/타이밍 누출을 막는다(쿨다운에
   * 걸려도 throw 하지 않고 조용히 반환 — 열거 방어 유지).
   */
  async requestReset(emailRaw: string, now: Date = new Date()): Promise<void> {
    const email = emailRaw.trim().toLowerCase();

    // 이메일당 쿨다운(메일 폭탄 방지). 점유 실패(이미 최근 발송)면 조용히 반환한다 — 응답은
    // 존재/쿨다운 여부와 무관하게 항상 200(열거·타이밍 누출 방지). EmailVerification resend 의
    // NX 원자 점유 패턴을 따르되, 여기서는 429 를 던지지 않는다(공개 엔드포인트 열거 방어).
    const cooldownKey = `password_reset_cooldown:${email}`;
    const claimed = await this.redis.set(
      cooldownKey,
      '1',
      'EX',
      PASSWORD_RESET_RESEND_COOLDOWN_SEC,
      'NX',
    );
    if (claimed === null) {
      // 쿨다운 중 — 재발송하지 않고 조용히 반환(열거 방어).
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, isDeactivated: true },
    });
    // 미존재/비활성 계정은 토큰/메일 없이 조용히 반환한다(열거 방어 — 응답은 동일하게 성공).
    if (!user || user.isDeactivated) {
      return;
    }

    const token = randomUUID();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_SEC * 1000);
    await this.prisma.passwordResetToken.create({
      data: { id: randomUUID(), userId: user.id, tokenHash: this.hashToken(token), expiresAt },
    });
    await this.mail.sendPasswordResetEmail(user.email, this.resetUrl(token));
  }

  /**
   * POST /auth/reset-password. 토큰 유효성(형식→조회→미사용→미만료)을 검증하고, 단일 tx CAS 로
   * 1회 소모하면서 argon2 재해싱으로 비밀번호를 교체한다. 성공 시 해당 사용자의 전 RefreshToken
   * 을 revoke 한다(전 기기 강제 로그아웃 · FR-AUTH-42).
   *
   * 거부 코드(EmailVerification 컨벤션):
   *   - 형식오류/미존재/이미 사용됨 → PASSWORD_RESET_TOKEN_INVALID(400)
   *   - 만료(발급 1h 경과)         → PASSWORD_RESET_TOKEN_EXPIRED(410)
   * 비밀번호 정책은 컨트롤러의 ResetPasswordRequestSchema(PasswordSchema = min(8))가 선검증한다.
   *
   * @returns 재설정된 사용자 id(관측/로그용).
   */
  async reset(
    token: string,
    newPassword: string,
    now: Date = new Date(),
  ): Promise<{ userId: string }> {
    // 토큰 형식 가드(누출 방지 — 형식오류도 미존재와 동일하게 INVALID). raw 토큰은 uuid v4.
    if (!isUuid(token)) {
      throw new DomainError(ErrorCode.PASSWORD_RESET_TOKEN_INVALID, 'invalid password reset token');
    }
    const tokenHash = this.hashToken(token);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });
    if (!row || row.usedAt) {
      throw new DomainError(ErrorCode.PASSWORD_RESET_TOKEN_INVALID, 'invalid password reset token');
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new DomainError(ErrorCode.PASSWORD_RESET_TOKEN_EXPIRED, 'password reset token expired');
    }

    // security MED: 새 비밀번호도 signup/changePassword 와 동일한 강도 정책(min 8 + 3 class)을
    // 강제한다. 컨트롤러 Zod(PasswordSchema)는 길이(min 8)만 보므로 'aaaaaaaa' 같은 단일 클래스
    // 약비번이 통과할 수 있다 — 해싱 전에 거부해 약비번 저장을 막는다(AUTH_WEAK_PASSWORD).
    this.passwords.validateStrength(newPassword);

    // 보안 알림 발송을 위해 토큰 소유자의 등록 이메일을 함께 읽는다(reset 성공 후 통지용).
    const owner = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { email: true },
    });
    const userEmail = owner?.email ?? null;

    // argon2 해싱은 트랜잭션 밖에서 미리 수행한다(DB 락 시간 단축). CAS 소모는 tx 안에서.
    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      // usedAt CAS — 동시 reset 레이스에서 한쪽만 성공시킨다(이미 사용됐으면 count=0).
      const used = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (used.count === 0) {
        throw new DomainError(
          ErrorCode.PASSWORD_RESET_TOKEN_INVALID,
          'invalid password reset token',
        );
      }
      await tx.user.update({
        where: { id: row.userId },
        // 비밀번호 변경 시 로그인 잠금/실패 카운터도 함께 초기화한다(잠긴 계정도 재설정으로
        // 다시 로그인 가능해야 한다 — login() 의 updateLoginSuccess 와 동일한 해소).
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
      });
    });

    // FR-AUTH-42: 비밀번호 재설정 성공 시 해당 사용자의 모든 활성 세션을 강제 로그아웃한다.
    // exceptFamilyId=null → 전 RefreshToken revoke(비로그인 플로우라 보존할 현재 세션 없음).
    await this.tokens.revokeAllExceptFamily(row.userId, null);

    this.logger.log(JSON.stringify({ event: 'password_reset_completed', userId: row.userId }));

    // reviewer MAJOR: 재설정 성공 후 등록 이메일로 보안 알림을 보낸다(본인 외 토큰 탈취·재설정
    // 조기 인지). best-effort — MailSender 계약은 throw 하지 않지만(SmtpMailSender 도 fail-open),
    // 방어심층으로 try/catch 해 메일 실패가 이미 완료된 reset tx 결과를 깨지 않게 한다.
    if (userEmail) {
      try {
        await this.mail.sendSecurityAlertEmail(userEmail, 'password_changed');
      } catch (err) {
        this.logger.warn(
          JSON.stringify({
            event: 'password_reset_alert_failed',
            userId: row.userId,
            reason: err instanceof Error ? err.message : 'unknown',
          }),
        );
      }
    }

    return { userId: row.userId };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
