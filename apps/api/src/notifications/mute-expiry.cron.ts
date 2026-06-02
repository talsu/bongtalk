import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.module';

/**
 * S46 (D06 / FR-MN-08 / ADR-6): 뮤트 만료 cron.
 *
 * ServerNotificationPref·UserChannelMute 의 `muteUntil`/`mutedUntil` 이 과거가
 * 된 활성 뮤트를 1분 주기로 해제한다. fanout 게이트는 이미 query-time 에
 * `mutedUntil > now` 로 만료 행을 무시하므로 알림 정확성에는 cron 이 불필요하나,
 * "뮤트 만료 시 UI 상태(배지/사이드바)가 자동 복원"되려면 영속 상태도 정리돼야
 * 한다(ADR-6: "뮤트 만료 시 스케줄러가 isMuted=false 로 업데이트").
 *
 *   - ServerNotificationPref: isMuted && muteUntil < now → isMuted=false, muteUntil=null.
 *   - UserChannelMute: 채널 뮤트는 행 존재 + mutedUntil 로 표현하므로, 만료
 *     (mutedUntil < now)된 행은 level 오버라이드 보존 여부로 분기한다 —
 *       · level 이 NULL(상속만) → 행 삭제(뮤트 종료 = 흔적 없음).
 *       · level 이 NOT NULL(레벨 오버라이드 유지) → mutedUntil=NULL 로 비워 뮤트만 해제.
 *
 * Redis TTL push 연동(만료 즉시 다기기 반영)은 VAPID 슬라이스로 defer.
 * 멀티-노드 시 여러 인스턴스가 동시에 같은 UPDATE 를 돌려도 멱등이라 무해하다.
 */
@Injectable()
export class MuteExpiryCron {
  private readonly logger = new Logger(MuteExpiryCron.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 만료 뮤트를 해제하고, 정리된 (server, channelCleared, channelUnmuted) 건수를
   * 반환한다. cron 핸들러와 단위/통합 테스트가 공유한다.
   */
  async sweep(now: Date): Promise<{
    server: number;
    channelCleared: number;
    channelUnmuted: number;
  }> {
    const server = await this.prisma.serverNotificationPref.updateMany({
      where: { isMuted: true, muteUntil: { not: null, lt: now } },
      data: { isMuted: false, muteUntil: null },
    });

    // 만료 채널 뮤트 중 level 상속(NULL)인 행은 삭제(흔적 제거).
    const channelCleared = await this.prisma.userChannelMute.deleteMany({
      where: { mutedUntil: { not: null, lt: now }, level: null },
    });
    // level 오버라이드가 살아있는 만료 행은 뮤트만 해제(mutedUntil=NULL).
    const channelUnmuted = await this.prisma.userChannelMute.updateMany({
      where: { mutedUntil: { not: null, lt: now }, level: { not: null } },
      data: { mutedUntil: null },
    });

    return {
      server: server.count,
      channelCleared: channelCleared.count,
      channelUnmuted: channelUnmuted.count,
    };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async runMinutely(): Promise<void> {
    try {
      const r = await this.sweep(new Date());
      const total = r.server + r.channelCleared + r.channelUnmuted;
      if (total > 0) {
        this.logger.log(
          `mute expiry swept: server=${r.server} channelCleared=${r.channelCleared} channelUnmuted=${r.channelUnmuted}`,
        );
      }
    } catch (err) {
      this.logger.error('mute expiry sweep failed', err as Error);
    }
  }
}
