import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S15 (FR-CH-08): 채널 슬로우모드 게이트.
 *
 * 송신 경로(MessagesController.send)에서 메시지 영속화 직전에 호출한다.
 * 동작:
 *   - slowmodeSeconds === 0 → 무동작(즉시 통과).
 *   - BYPASS_SLOWMODE 비트 보유자(OWNER/ADMIN baseline + 채널 override) → 통과.
 *   - 그 외: Redis `slowmode:{channelId}:{userId}` 키의 잔여 TTL 을 검사.
 *       · 키 존재(쿨다운 중) → CHANNEL_SLOWMODE_ACTIVE(429) + details.retryAfterMs.
 *       · 키 없음(통과) → `SET key 1 EX slowmodeSeconds NX` 로 쿨다운 시작.
 *
 * Redis 장애 fallback(1차 방어만):
 *   Redis 명령이 throw 하면 DB 의 최근 메시지 createdAt 을 읽어 경과 시간이
 *   slowmodeSeconds 미만이면 차단한다. Redis 의 NX-원자성/정밀 TTL 은 없지만
 *   BYPASS 미보유자가 무제한으로 우회하지는 못한다(과설계 금지 — 단일 최근
 *   메시지 비교까지만).
 */
@Injectable()
export class SlowmodeService {
  private readonly logger = new Logger(SlowmodeService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  private key(channelId: string, userId: string): string {
    return `slowmode:${channelId}:${userId}`;
  }

  /**
   * 슬로우모드 게이트. 통과 시 쿨다운을 시작(SET)하고 void 반환. 잔여 쿨다운이
   * 있으면 CHANNEL_SLOWMODE_ACTIVE(429) 를 던진다.
   *
   * @param hasBypass 호출자가 BYPASS_SLOWMODE 비트를 가졌는지(상위에서 계산).
   */
  async enforce(args: {
    channelId: string;
    userId: string;
    slowmodeSeconds: number;
    hasBypass: boolean;
  }): Promise<void> {
    const { channelId, userId, slowmodeSeconds, hasBypass } = args;
    if (slowmodeSeconds <= 0) return;
    if (hasBypass) return;

    try {
      // pttl 은 밀리초 잔여를 반환: -2(키 없음) / -1(만료 없음) / >0(잔여 ms).
      const pttl = await this.redis.pttl(this.key(channelId, userId));
      if (pttl > 0) {
        throw new DomainError(
          ErrorCode.CHANNEL_SLOWMODE_ACTIVE,
          `slowmode active — retry in ${Math.ceil(pttl / 1000)}s`,
          { retryAfterMs: pttl },
        );
      }
      // 통과 → NX 로 쿨다운 시작. 동시 송신 레이스에서도 NX 가 한 명만 통과시킨다.
      const set = await this.redis.set(
        this.key(channelId, userId),
        '1',
        'EX',
        slowmodeSeconds,
        'NX',
      );
      if (set === null) {
        // 경합으로 다른 송신이 먼저 키를 잡음 → 잔여를 다시 읽어 거부.
        const racePttl = await this.redis.pttl(this.key(channelId, userId));
        throw new DomainError(ErrorCode.CHANNEL_SLOWMODE_ACTIVE, 'slowmode active', {
          retryAfterMs: racePttl > 0 ? racePttl : slowmodeSeconds * 1000,
        });
      }
    } catch (e) {
      if (e instanceof DomainError) throw e;
      // Redis 장애 → DB 최근 메시지 타임스탬프로 1차 방어.
      this.logger.warn(`redis slowmode check failed, falling back to DB: ${(e as Error).message}`);
      await this.enforceViaDbFallback({ channelId, userId, slowmodeSeconds });
    }
  }

  /**
   * Redis 장애 fallback. 채널에서 호출자가 보낸 가장 최근 메시지의 createdAt 을
   * 읽어, 경과가 slowmodeSeconds 미만이면 차단한다. soft-delete 메시지도 포함해
   * 삭제로 쿨다운을 우회하지 못하게 한다.
   */
  private async enforceViaDbFallback(args: {
    channelId: string;
    userId: string;
    slowmodeSeconds: number;
  }): Promise<void> {
    const { channelId, userId, slowmodeSeconds } = args;
    const last = await this.prisma.message.findFirst({
      where: { channelId, authorId: userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!last) return; // 첫 메시지 → 통과.
    const elapsedMs = Date.now() - last.createdAt.getTime();
    const windowMs = slowmodeSeconds * 1000;
    if (elapsedMs < windowMs) {
      throw new DomainError(ErrorCode.CHANNEL_SLOWMODE_ACTIVE, 'slowmode active (degraded mode)', {
        retryAfterMs: windowMs - elapsedMs,
      });
    }
  }
}
