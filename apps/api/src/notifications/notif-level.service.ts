import { Injectable } from '@nestjs/common';
import type { NotifLevel, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import {
  isMuteActive,
  resolveEffectiveLevel,
  shouldNotifyMention,
  type MentionKind,
  type ResolvedNotifInputs,
} from './notif-level';

/**
 * S46 (D06 / FR-MN-05/06/07/08): NotifLevel 3계층 batch 로더.
 *
 * 멘션 fanout 의 N+1 을 막는다 — per-recipient 쿼리 대신, 후보 수신자 전체
 * (userId in [...])의 글로벌/서버/채널 prefs 를 각 1쿼리(총 3쿼리)로 일괄 로드한
 * 뒤, 메모리에서 per-recipient fold 하는 클로저를 돌려준다. 호출부(messages.
 * service)는 동일 tx 를 prismaClient 로 주입해 atomic snapshot 을 보장한다
 * (mute/DND 게이트와 동일 규약).
 *
 * channelLevel 은 호출부가 이미 같은 tx 에서 조회하는 UserChannelMute 행
 * (mute 게이트용)에서 함께 얻을 수 있으나, 여기서는 책임 분리를 위해 자체
 * 로드한다. 채널 뮤트(isMuted) 도 같은 테이블에서 함께 판정한다(행 존재 +
 * mutedUntil null|미래).
 */
export interface NotifGate {
  /** 이 수신자에게 이 종류(direct/broad)의 멘션 알림을 보낼지. */
  shouldNotify(userId: string, kind: MentionKind): boolean;
  /** 디버그/테스트용 — effective level (3계층 fold 결과). */
  effectiveLevel(userId: string): NotifLevel;
}

type Client = Pick<PrismaClient, 'userSettings' | 'serverNotificationPref' | 'userChannelMute'>;

@Injectable()
export class NotifLevelService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 후보 수신자 전원의 3계층 prefs 를 일괄 로드해 게이트 클로저를 만든다.
   * candidateUserIds 가 비면 모두 false 를 돌려주는 게이트를 즉시 반환한다.
   *
   * @param prismaClient 가능하면 호출부의 tx 를 주입(atomic snapshot).
   */
  async buildGate(
    args: {
      channelId: string;
      workspaceId: string | null;
      candidateUserIds: string[];
      now: Date;
    },
    prismaClient: Client = this.prisma,
  ): Promise<NotifGate> {
    const { channelId, workspaceId, candidateUserIds, now } = args;
    const uniqueIds = Array.from(new Set(candidateUserIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
      return {
        shouldNotify: () => false,
        effectiveLevel: () => 'MENTIONS',
      };
    }

    // 3 batch findMany — per-recipient 쿼리 금지(N+1 방지).
    const [globalRows, serverRows, channelRows] = await Promise.all([
      prismaClient.userSettings.findMany({
        where: { userId: { in: uniqueIds } },
        select: { userId: true, notifTrigger: true },
      }),
      workspaceId
        ? prismaClient.serverNotificationPref.findMany({
            where: { userId: { in: uniqueIds }, workspaceId },
            // suppressEveryone/suppressRoleMentions 를 같은 쿼리 select 에 더한다
            // (추가 쿼리 없음 — MENTIONS broad opt-out 게이트용).
            select: {
              userId: true,
              level: true,
              isMuted: true,
              muteUntil: true,
              suppressEveryone: true,
              suppressRoleMentions: true,
            },
          })
        : Promise.resolve([]),
      prismaClient.userChannelMute.findMany({
        where: { userId: { in: uniqueIds }, channelId },
        // S46 fix-forward (BLOCKER 3): isMuted 를 함께 읽어 mutedUntil 과 분리
        // 판정(level-only 비뮤트 행이 채널 차단으로 오작동하지 않게).
        select: { userId: true, level: true, mutedUntil: true, isMuted: true },
      }),
    ]);

    const globalByUser = new Map<string, NotifLevel>();
    for (const r of globalRows) globalByUser.set(r.userId, r.notifTrigger);

    const serverByUser = new Map<
      string,
      { level: NotifLevel; muted: boolean; suppressEveryone: boolean }
    >();
    for (const r of serverRows) {
      serverByUser.set(r.userId, {
        level: r.level,
        muted: isMuteActive(r.isMuted, r.muteUntil, now),
        suppressEveryone: r.suppressEveryone,
      });
    }

    const channelByUser = new Map<string, { level: NotifLevel | null; muted: boolean }>();
    for (const r of channelRows) {
      // S46 fix-forward (BLOCKER 3): 활성 채널 뮤트 = isMuted && (mutedUntil null=영구
      // | mutedUntil>now). level 오버라이드만 있고 isMuted=false 인 행은 뮤트 아님.
      channelByUser.set(r.userId, {
        level: r.level,
        muted: isMuteActive(r.isMuted, r.mutedUntil, now),
      });
    }

    const inputsFor = (userId: string): ResolvedNotifInputs => {
      const ch = channelByUser.get(userId);
      const sv = serverByUser.get(userId);
      return {
        channelLevel: ch?.level ?? null,
        serverLevel: sv?.level ?? null,
        globalLevel: globalByUser.get(userId) ?? null,
        serverMuted: sv?.muted ?? false,
        channelMuted: ch?.muted ?? false,
        suppressEveryone: sv?.suppressEveryone ?? false,
      };
    };

    return {
      shouldNotify: (userId, kind) => shouldNotifyMention(inputsFor(userId), kind),
      effectiveLevel: (userId) => resolveEffectiveLevel(inputsFor(userId)),
    };
  }
}
