import { Injectable } from '@nestjs/common';
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
   */
  async filterMutedRecipients(
    channelId: string,
    candidateUserIds: string[],
    prismaClient: Pick<PrismaClient, 'userChannelMute'> = this.prisma,
  ): Promise<string[]> {
    if (candidateUserIds.length === 0) return [];
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
