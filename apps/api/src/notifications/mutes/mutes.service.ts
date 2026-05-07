import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';

/**
 * task-045 iter3: channel/DM mute service.
 *
 * 정책:
 *  - mute > event-type pref 우선 — muted channel 의 모든 알림 차단.
 *  - mutedUntil null = indefinite. 미래 시각 = 그 시점까지만 활성.
 *  - 만료된 mute 는 query 시 자동 제외 — cleanup job 없음.
 *  - DM 채널도 같은 테이블 사용 (channelId 가 DIRECT type 가능).
 *
 * 호출자는 channel access 권한을 별도 가드해야 합니다 — 이 service
 * 자체는 권한 체크 없음.
 */

export type MuteRow = {
  channelId: string;
  mutedUntil: Date | null;
  createdAt: Date;
};

@Injectable()
export class MutesService {
  private readonly logger = new Logger(MutesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * channel mute upsert. 이미 존재 시 mutedUntil 만 갱신.
   */
  async setMute(args: {
    userId: string;
    channelId: string;
    mutedUntil: Date | null;
  }): Promise<MuteRow> {
    const row = await this.prisma.userChannelMute.upsert({
      where: { userId_channelId: { userId: args.userId, channelId: args.channelId } },
      create: {
        userId: args.userId,
        channelId: args.channelId,
        mutedUntil: args.mutedUntil,
      },
      update: { mutedUntil: args.mutedUntil },
    });
    return {
      channelId: row.channelId,
      mutedUntil: row.mutedUntil,
      createdAt: row.createdAt,
    };
  }

  /** mute 해제 — 행 삭제. 미존재 면 idempotent. */
  async removeMute(args: { userId: string; channelId: string }): Promise<void> {
    await this.prisma.userChannelMute.deleteMany({
      where: { userId: args.userId, channelId: args.channelId },
    });
  }

  /**
   * 사용자의 활성 mute 목록 (만료된 항목 자동 제외).
   * 정렬: createdAt DESC.
   */
  async listActiveMutes(userId: string): Promise<MuteRow[]> {
    const now = new Date();
    const rows = await this.prisma.userChannelMute.findMany({
      where: {
        userId,
        OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      channelId: r.channelId,
      mutedUntil: r.mutedUntil,
      createdAt: r.createdAt,
    }));
  }

  /**
   * task-045 iter3: 후보 recipient 목록에서 채널 muted user 를 제외.
   * mention/reply 등의 outbox emit 직전 호출. 만료된 mute 는 자동 제외.
   * 빈 목록은 빠른 return.
   *
   * task-046 iter0 (MED-2 carry-over): 호출자는 가급적 messages.service
   * 처럼 transaction client (`tx`) 를 prismaClient 로 주입할 것. tx 누락
   * 시 mute 행 변경과 emit 사이에 race 가 생길 수 있음. 본 메서드 자체
   * 에서는 보호하지 않음 — 호출 라인 (mention dispatcher / outbox emit)
   * 이 동일 tx 안에 있어야 atomic snapshot 보장.
   *
   * @param channelId — DM 또는 일반 채널 모두 가능
   * @param candidateUserIds — UI 가 표시 중인 잠재 수신자 list
   * @param prismaClient — 가능하면 동일 transaction 의 tx 를 주입.
   *   기본값 (this.prisma) 은 외부 호출 호환을 위한 fallback.
   */
  async filterMutedRecipients(
    channelId: string,
    candidateUserIds: string[],
    prismaClient: Pick<PrismaClient, 'userChannelMute'> = this.prisma,
  ): Promise<string[]> {
    if (candidateUserIds.length === 0) return [];
    if (prismaClient === this.prisma) {
      // task-046 iter0 (MED-2): 의도된 fallback 인지 호출 site 추적용
      // log 1줄. 동작 변경 없음, 가시성만 추가. dev/staging 에서 호출
      // 패턴 발견 시 messages.service 처럼 tx 주입으로 마이그.
      this.logger.warn(
        `filterMutedRecipients called without tx — atomic snapshot not guaranteed (channelId=${channelId}, candidates=${candidateUserIds.length})`,
      );
    }
    const now = new Date();
    const muted = await prismaClient.userChannelMute.findMany({
      where: {
        channelId,
        userId: { in: candidateUserIds },
        OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
      },
      select: { userId: true },
    });
    if (muted.length === 0) return candidateUserIds;
    const mutedSet = new Set(muted.map((m) => m.userId));
    return candidateUserIds.filter((u) => !mutedSet.has(u));
  }
}
