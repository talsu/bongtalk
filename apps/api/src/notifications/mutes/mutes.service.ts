import { Injectable, Logger } from '@nestjs/common';
import type { NotifLevel, PrismaClient } from '@prisma/client';
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
 * S46 fix-forward (BLOCKER 3): UserChannelMute 에 isMuted 명시 축이 생겼다. 본
 * 서비스(S43 mute UI)는 "실제 뮤트" 만 다루므로 setMute 가 isMuted=true 를 set 하고,
 * 활성 판정/소비처(listActiveMutes·filterMutedRecipients)는 isMuted=true 인 행만
 * 본다. S46 level-only 비뮤트 행(isMuted=false)은 여기서 뮤트로 취급되지 않는다.
 *
 * 호출자는 channel access 권한을 별도 가드해야 합니다 — 이 service
 * 자체는 권한 체크 없음.
 */

export type MuteRow = {
  channelId: string;
  mutedUntil: Date | null;
  createdAt: Date;
};

/**
 * S49 (D06 / FR-MN-17): "현재 뮤트 중" 채널 목록 항목 — Channel/Workspace join 으로
 * 보강한 활성 채널 뮤트 1행. 삭제 채널(Channel.deletedAt)은 listActiveMutesDetailed
 * 가 제외하므로 여기엔 등장하지 않는다. workspaceId/workspaceName 은 DM(workspace
 * 없음)이면 null.
 */
export type DetailedMuteRow = {
  channelId: string;
  channelName: string;
  workspaceId: string | null;
  workspaceName: string | null;
  mutedUntil: Date | null;
  createdAt: Date;
};

/**
 * S49 (FR-MN-17): "현재 뮤트 중" 서버(워크스페이스) 목록 항목 — 활성 서버 뮤트 1행.
 */
export type ServerMuteRow = {
  workspaceId: string;
  workspaceName: string;
  workspaceIconUrl: string | null;
  muteUntil: Date | null;
  level: NotifLevel;
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
    // S46 fix-forward (BLOCKER 3): S43 뮤트는 실제 뮤트이므로 isMuted=true 를 명시
    // set 한다(기존 level 오버라이드가 있던 행이면 보존 — level 은 건드리지 않음).
    const row = await this.prisma.userChannelMute.upsert({
      where: { userId_channelId: { userId: args.userId, channelId: args.channelId } },
      create: {
        userId: args.userId,
        channelId: args.channelId,
        mutedUntil: args.mutedUntil,
        isMuted: true,
      },
      update: { mutedUntil: args.mutedUntil, isMuted: true },
    });
    return {
      channelId: row.channelId,
      mutedUntil: row.mutedUntil,
      createdAt: row.createdAt,
    };
  }

  /**
   * mute 해제. S46 fix-forward (BLOCKER 3): level 오버라이드가 있으면 보존하고
   * (isMuted=false·mutedUntil=null) 뮤트만 푼다. level 상속(null)이면 흔적 없는
   * 행이라 삭제한다. 미존재면 idempotent.
   */
  async removeMute(args: { userId: string; channelId: string }): Promise<void> {
    const existing = await this.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId: args.userId, channelId: args.channelId } },
      select: { level: true },
    });
    if (!existing) return;
    if (existing.level === null) {
      await this.prisma.userChannelMute.deleteMany({
        where: { userId: args.userId, channelId: args.channelId },
      });
      return;
    }
    await this.prisma.userChannelMute.update({
      where: { userId_channelId: { userId: args.userId, channelId: args.channelId } },
      data: { isMuted: false, mutedUntil: null },
    });
  }

  /**
   * 사용자의 활성 mute 목록 (만료된 항목 자동 제외).
   * 정렬: createdAt DESC.
   */
  async listActiveMutes(userId: string): Promise<MuteRow[]> {
    const now = new Date();
    // S46 fix-forward (BLOCKER 3): 활성 뮤트 = isMuted=true && (mutedUntil null=영구
    // | mutedUntil>now). level-only 비뮤트 행(isMuted=false)은 제외.
    const rows = await this.prisma.userChannelMute.findMany({
      where: {
        userId,
        isMuted: true,
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
   * S49 (D06 / FR-MN-17): "현재 뮤트 중" 채널 목록(보강판). listActiveMutes 와 같은
   * 활성 판정(isMuted=true && (mutedUntil null=영구 | mutedUntil>now))을 쓰되,
   * Channel/Workspace 를 join 해 channelName·workspaceId·workspaceName 을 함께
   * 반환한다. **삭제 채널(Channel.deletedAt IS NOT NULL)은 제외**한다 — relation
   * filter `channel: { deletedAt: null }` 로 query-time 에 거른다(목록에 유령
   * 채널이 남지 않도록). 정렬: createdAt DESC(최근 뮤트가 위).
   */
  async listActiveMutesDetailed(userId: string): Promise<DetailedMuteRow[]> {
    const now = new Date();
    const rows = await this.prisma.userChannelMute.findMany({
      where: {
        userId,
        isMuted: true,
        OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
        // FR-MN-17: 삭제 채널 제외 — soft-deleted 채널은 목록에 노출하지 않는다.
        channel: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        channelId: true,
        mutedUntil: true,
        createdAt: true,
        channel: {
          select: {
            name: true,
            displayName: true,
            workspaceId: true,
            workspace: { select: { name: true } },
          },
        },
      },
    });
    return rows.map((r) => ({
      channelId: r.channelId,
      // DM(group/1:1)은 displayName 이 사용자 표시명이라 우선(없으면 dedup slug name).
      channelName: r.channel.displayName ?? r.channel.name,
      workspaceId: r.channel.workspaceId,
      workspaceName: r.channel.workspace?.name ?? null,
      mutedUntil: r.mutedUntil,
      createdAt: r.createdAt,
    }));
  }

  /**
   * S49 (FR-MN-17): "현재 뮤트 중" 서버(워크스페이스) 목록. ServerNotificationPref
   * 중 isMuted=true 이고 (muteUntil null=영구 | muteUntil>now)인 활성 서버 뮤트만
   * Workspace join 해 반환한다. 삭제 워크스페이스(Workspace.deletedAt)는 제외한다.
   * 정렬: createdAt DESC. 만료 행은 cron sweep 전에도 query-time 에 제외된다.
   */
  async listActiveServerMutes(userId: string): Promise<ServerMuteRow[]> {
    const now = new Date();
    const rows = await this.prisma.serverNotificationPref.findMany({
      where: {
        userId,
        isMuted: true,
        OR: [{ muteUntil: null }, { muteUntil: { gt: now } }],
        // 삭제 워크스페이스 제외 — 채널 뮤트와 대칭.
        workspace: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        workspaceId: true,
        muteUntil: true,
        level: true,
        workspace: { select: { name: true, iconUrl: true } },
      },
    });
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      workspaceName: r.workspace.name,
      workspaceIconUrl: r.workspace.iconUrl,
      muteUntil: r.muteUntil,
      level: r.level,
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
    // S46 fix-forward (BLOCKER 3): 활성 뮤트 = isMuted=true && (mutedUntil null|미래).
    const muted = await prismaClient.userChannelMute.findMany({
      where: {
        channelId,
        userId: { in: candidateUserIds },
        isMuted: true,
        OR: [{ mutedUntil: null }, { mutedUntil: { gt: now } }],
      },
      select: { userId: true },
    });
    if (muted.length === 0) return candidateUserIds;
    const mutedSet = new Set(muted.map((m) => m.userId));
    return candidateUserIds.filter((u) => !mutedSet.has(u));
  }
}
