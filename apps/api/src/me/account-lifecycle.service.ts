import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.module';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { PasswordService } from '../auth/services/password.service';
import { TwoFactorService } from '../auth/services/two-factor.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * S77c (D14 / FR-PS-16): 계정 비활성화 / 재활성화.
 *
 *   deactivate: 현재 비번(+2FA 활성 시 totpCode) 재확인 → 단일 트랜잭션으로 isDeactivated=true +
 *     deactivatedAt=now + 해당 유저 RefreshToken 전체 삭제. tx 커밋 직후 Redis `deactivated:{userId}`
 *     TTL 15m SET(즉시 차단 블랙리스트) + `search:recent:{userId}` DEL(검색 이력 정리) + 활성 소켓에
 *     `session:revoked` emit + kickUserEverywhere(강제 disconnect).
 *   reactivate: 로그인 자격증명(email+password, 2FA 활성 시 totpCode) 검증 → 30일 이내면
 *     isDeactivated=false + deactivatedAt=null 로 복구 + Redis 블랙리스트 DEL.
 *
 * ★ 30일 익명화는 AccountAnonymizationCron 이 별도로 수행한다(이 서비스는 비활성/복구 상태만 토글).
 * ★ 비활성 계정의 모든 인증 요청 차단은 JwtStrategy 의 이중검사(DB isDeactivated + Redis 블랙리스트)
 *   가 담당한다. Redis TTL(15m)은 즉시성, DB 컬럼은 영속성을 책임지는 이중 안전망이다.
 */
@Injectable()
export class AccountLifecycleService {
  private readonly logger = new Logger(AccountLifecycleService.name);

  // Redis `deactivated:{userId}` 블랙리스트 TTL(초). 15분 — access token TTL(15m)과 정렬해
  // 토큰이 살아 있는 동안 즉시 차단을 보장하고, 이후엔 DB isDeactivated 가 단일 출처로 계속 막는다.
  static readonly DEACTIVATED_BLACKLIST_TTL_SEC = 15 * 60;
  // FR-PS-16/19: 비활성화 후 복구 가능 창(일). 익명화 크론은 이 창이 지난 row 만 영구 익명화한다.
  static readonly RECOVERY_WINDOW_DAYS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly twoFactor: TwoFactorService,
    private readonly realtime: RealtimeGateway,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * 본인 계정 비활성화. 현재 비번(+2FA 시 totpCode) 재확인 후 단일 트랜잭션으로 상태 전환 +
   * RefreshToken 전체 삭제. tx 커밋 직후 Redis 블랙리스트 SET + 검색 이력 DEL + 소켓 강제 종료.
   */
  async deactivate(userId: string, currentPassword: string, totpCode?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, isDeactivated: true },
    });
    if (!user) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'user not found');
    }
    const ok = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!ok) {
      throw new DomainError(ErrorCode.PASSWORD_INCORRECT, 'current password is incorrect');
    }
    // S77b 패턴 일관: 2FA 활성 사용자는 totpCode 재확인이 통과해야 비활성화할 수 있다(미활성이면 no-op).
    await this.twoFactor.assertCredentialChangeTotp(userId, totpCode);

    // 단일 트랜잭션: 상태 전환 + 해당 유저 RefreshToken 전체 삭제(세션 즉시 무효화). isDeactivated
    // 가 이미 true 면 deactivatedAt 을 갱신하지 않는다(멱등 — 복구창 시작 시점 보존).
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: user.isDeactivated
          ? { isDeactivated: true }
          : { isDeactivated: true, deactivatedAt: now },
      });
      await tx.refreshToken.deleteMany({ where: { userId } });
    });

    // tx 커밋 직후: Redis 블랙리스트 SET(즉시 차단) + 검색 이력 DEL. keyPrefix(qufox:)는 ioredis 가
    // 자동 부여하므로 여기선 논리 키만 쓴다.
    await this.redis.set(
      deactivatedKey(userId),
      '1',
      'EX',
      AccountLifecycleService.DEACTIVATED_BLACKLIST_TTL_SEC,
    );
    await this.redis.del(recentSearchKey(userId));

    // 활성 소켓에 session:revoked emit 후 강제 disconnect(다기기 즉시 로그아웃).
    this.realtime.emitToUserRoom(userId, 'session:revoked', { reason: 'account_deactivated' });
    await this.realtime.kickUserEverywhere(userId, 'account_deactivated');

    this.logger.log(JSON.stringify({ event: 'account.deactivated', userId }));
  }

  /**
   * 계정 재활성화. 비활성 계정은 로그인 차단되므로 로그인 자격증명(email+password, 2FA 시 totpCode)을
   * 직접 받아 검증한다(★단순화 결정 — 별도 복구 토큰 미발급). 30일 복구창 이내여야 한다.
   */
  async reactivate(
    email: string,
    password: string,
    totpCode?: string,
  ): Promise<{ id: string; email: string; username: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        passwordHash: true,
        isDeactivated: true,
        deactivatedAt: true,
      },
    });
    // 자격증명 노출 회피: 계정 부재/비번 불일치 모두 PASSWORD_INCORRECT(중립)로 응답한다.
    if (!user) {
      await this.passwords.dummyVerify(password);
      throw new DomainError(ErrorCode.PASSWORD_INCORRECT, 'invalid credentials');
    }
    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      throw new DomainError(ErrorCode.PASSWORD_INCORRECT, 'invalid credentials');
    }
    if (!user.isDeactivated) {
      throw new DomainError(ErrorCode.ACCOUNT_NOT_DEACTIVATED, 'account is not deactivated');
    }
    // 2FA 활성 사용자는 복구에도 totpCode 를 재확인한다(S77b 패턴 일관).
    await this.twoFactor.assertCredentialChangeTotp(user.id, totpCode);

    // 30일 복구창 검증 — 창이 지났으면(익명화 대상) 복구를 거부한다(ACCOUNT_DEACTIVATED 유지).
    const cutoff = new Date(
      Date.now() - AccountLifecycleService.RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    if (user.deactivatedAt && user.deactivatedAt.getTime() < cutoff.getTime()) {
      throw new DomainError(
        ErrorCode.ACCOUNT_DEACTIVATED,
        'recovery window has elapsed; account can no longer be reactivated',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isDeactivated: false, deactivatedAt: null },
    });
    await this.redis.del(deactivatedKey(user.id));

    this.logger.log(JSON.stringify({ event: 'account.reactivated', userId: user.id }));
    return { id: user.id, email: user.email, username: user.username };
  }
}

/** S77c (FR-PS-16): 비활성 계정 즉시 차단 블랙리스트 키. JwtStrategy 가 동일 키로 이중검사한다. */
export function deactivatedKey(userId: string): string {
  return `deactivated:${userId}`;
}

/** S30 (FR-S07): 검색 최근어 LIST 키(search.service 와 동일 규칙) — 비활성화 시 정리한다. */
function recentSearchKey(userId: string): string {
  return `search:recent:${userId}`;
}
