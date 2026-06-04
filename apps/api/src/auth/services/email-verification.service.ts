import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  EMAIL_VERIFY_RESEND_COOLDOWN_SEC,
  EMAIL_VERIFY_RESEND_DAILY_MAX,
  EMAIL_VERIFY_TOKEN_TTL_SEC,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { REDIS } from '../../redis/redis.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { MAIL_SENDER, type MailSender } from './mail.service';

/**
 * S66 (D13 / FR-W05a·W05b): 이메일 인증 토큰 생성/검증/재발송 + 재발송 rate-limit.
 *
 * 토큰은 추측 불가한 uuid v4 이며 발급 + 24h 후 만료된다. 검증 성공 시 토큰 행에
 * usedAt 을 찍고(재사용 차단) User.emailVerified=true 로 전환한다. 재발송은 Redis 키로
 * 60초 쿨다운(email_verify_resend:{userId})·1일 5회(email_verify_daily:{userId})를
 * 집행한다(기존 RateLimitService 의 고정-윈도우 패턴 차용 — 일일 카운트는 자정 경계가
 * 아닌 첫 발송 기준 24h sliding 으로 단순화).
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  private verifyUrl(token: string): string {
    const base = (process.env.WEB_URL ?? 'http://localhost:45173').replace(/\/$/, '');
    return `${base}/verify-email?token=${token}`;
  }

  /**
   * 신규 인증 토큰 1행을 생성한다. signup tx 외부에서 호출하며(verifyUrl 출력만), 같은
   * userId 의 미사용 토큰을 무효화하지는 않는다(최신 토큰만 유효해야 한다면 후속에서
   * usedAt 일괄 처리 가능 — MVP 는 다중 미사용 토큰을 모두 허용하되 만료/재사용만 막음).
   * @returns 생성된 토큰(raw uuid). 호출부가 메일 발송에 쓴다.
   */
  async createToken(userId: string, now: Date = new Date()): Promise<string> {
    const token = randomUUID();
    const expiresAt = new Date(now.getTime() + EMAIL_VERIFY_TOKEN_TTL_SEC * 1000);
    await this.prisma.emailVerificationToken.create({
      data: { id: randomUUID(), userId, token, expiresAt },
    });
    return token;
  }

  /** 토큰 생성 + Console stub 으로 verifyUrl 발송(signup·resend 공통 경로). */
  async issueAndSend(userId: string, email: string, now: Date = new Date()): Promise<void> {
    const token = await this.createToken(userId, now);
    await this.mail.sendVerificationEmail(email, this.verifyUrl(token));
  }

  /**
   * GET /auth/verify-email?token= 검증. 미존재/형식오류/이미 사용 → 400, 만료 → 410.
   * 성공 시 단일 트랜잭션에서 usedAt 기록 + User.emailVerified=true.
   * @returns 인증된 사용자 id.
   */
  async verify(token: string, now: Date = new Date()): Promise<{ userId: string }> {
    // uuid 형식이 아니면 token @db.Uuid 조회가 throw 하므로, 형식 검사를 선행한다(누출
    // 방지 — 형식오류도 미존재와 동일하게 INVALID 로 거부).
    if (!isUuid(token)) {
      throw new DomainError(
        ErrorCode.EMAIL_VERIFICATION_TOKEN_INVALID,
        'invalid verification token',
      );
    }
    const row = await this.prisma.emailVerificationToken.findUnique({
      where: { token },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });
    if (!row || row.usedAt) {
      throw new DomainError(
        ErrorCode.EMAIL_VERIFICATION_TOKEN_INVALID,
        'invalid verification token',
      );
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new DomainError(
        ErrorCode.EMAIL_VERIFICATION_TOKEN_EXPIRED,
        'verification token expired',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      // usedAt CAS — 동시 검증 레이스에서 한쪽만 성공시킨다(이미 사용됐으면 count=0).
      const used = await tx.emailVerificationToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (used.count === 0) {
        throw new DomainError(
          ErrorCode.EMAIL_VERIFICATION_TOKEN_INVALID,
          'invalid verification token',
        );
      }
      await tx.user.update({ where: { id: row.userId }, data: { emailVerified: true } });
    });
    return { userId: row.userId };
  }

  /**
   * POST /auth/resend-verification. 60초 쿨다운 + 1일 5회 한도(Redis). 한도 통과 시 새
   * 토큰 발급 + 메일 발송. 이미 인증된 사용자는 멱등하게 통과시키되 토큰을 만들지 않는다.
   * @returns 다음 재발송까지 쿨다운 초 + 그날 남은 재발송 횟수.
   */
  async resend(
    userId: string,
    email: string,
    now: Date = new Date(),
  ): Promise<{ cooldownSec: number; remainingToday: number }> {
    const cooldownKey = `email_verify_resend:${userId}`;
    const dailyKey = `email_verify_daily:${userId}`;

    // 쿨다운: 키가 존재하면 아직 60초 안 지남 → 429.
    const cooldownTtl = await this.redis.ttl(cooldownKey);
    if (cooldownTtl > 0) {
      throw new DomainError(
        ErrorCode.EMAIL_VERIFICATION_RATE_LIMITED,
        'verification email was sent recently — please wait before requesting again',
        { retryAfterSec: cooldownTtl },
      );
    }

    // 일일 한도: 고정-윈도우 카운터(첫 발송 기준 24h). 한도 도달 시 429.
    const dailyCount = await this.redis.incr(dailyKey);
    if (dailyCount === 1) {
      await this.redis.expire(dailyKey, 24 * 60 * 60);
    }
    if (dailyCount > EMAIL_VERIFY_RESEND_DAILY_MAX) {
      const dailyTtl = await this.redis.ttl(dailyKey);
      throw new DomainError(
        ErrorCode.EMAIL_VERIFICATION_RATE_LIMITED,
        'daily verification email limit reached — please try again later',
        { retryAfterSec: Math.max(dailyTtl, 1) },
      );
    }

    // 쿨다운 키 set(60s TTL) 후 발송.
    await this.redis.set(cooldownKey, '1', 'EX', EMAIL_VERIFY_RESEND_COOLDOWN_SEC);
    await this.issueAndSend(userId, email, now);

    return {
      cooldownSec: EMAIL_VERIFY_RESEND_COOLDOWN_SEC,
      remainingToday: Math.max(0, EMAIL_VERIFY_RESEND_DAILY_MAX - dailyCount),
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
