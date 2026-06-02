import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NotifLevel } from '@prisma/client';
import type {
  GlobalNotificationSettings,
  MuteDurationKey,
  ServerNotificationPreference,
  ChannelNotificationPreference,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import type { DndSchedule } from '../me/dnd-schedule.service';

/**
 * S46 (D06 / FR-MN-05/06/07/08): 글로벌/서버/채널 알림 설정 서비스.
 *
 *   - 글로벌  : UserSettings (userId @unique). 행 없으면 기본 MENTIONS.
 *   - 서버    : ServerNotificationPref ((userId, workspaceId) unique).
 *   - 채널    : UserChannelMute + level 컬럼 (기존 테이블 재사용 — deviation).
 *
 * 뮤트 기간(MuteDurationKey)을 muteUntil/mutedUntil 절대 시각으로 변환하는 로직은
 * muteUntilFrom 으로 모았다('forever' → null=영구). 권한 가드는 컨트롤러가 건다.
 */
const MUTE_DURATION_MS: Record<Exclude<MuteDurationKey, 'forever'>, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

/** 뮤트 기간 키 → 절대 종료 시각. 'forever'/미지정 → null(영구). */
export function muteUntilFrom(duration: MuteDurationKey | undefined, now: Date): Date | null {
  if (!duration || duration === 'forever') return null;
  return new Date(now.getTime() + MUTE_DURATION_MS[duration]);
}

@Injectable()
export class NotifPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 글로벌 (UserSettings) ────────────────────────────────────────────────

  /** 글로벌 알림 설정 조회. 행이 없으면 기본값(MENTIONS / 빈 keywords)을 반환. */
  async getGlobal(userId: string): Promise<GlobalNotificationSettings> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { notifTrigger: true, keywords: true, dndUntil: true, dndSchedule: true },
    });
    if (!row) {
      return { notifTrigger: 'MENTIONS', keywords: [], dndUntil: null, dndSchedule: null };
    }
    return {
      notifTrigger: row.notifTrigger,
      keywords: row.keywords,
      dndUntil: row.dndUntil ? row.dndUntil.toISOString() : null,
      dndSchedule: (row.dndSchedule as DndSchedule | null) ?? null,
    };
  }

  /**
   * 글로벌 알림 설정 부분 업데이트(upsert). 전달된 필드만 갱신한다.
   * keywords 스캔은 S46 에서 저장만 — 실제 스캔은 BullMQ(S45) 후속.
   */
  async updateGlobal(
    userId: string,
    patch: {
      notifTrigger?: NotifLevel;
      keywords?: string[];
      dndUntil?: string | null;
      dndSchedule?: DndSchedule | null;
    },
  ): Promise<GlobalNotificationSettings> {
    const update: Prisma.UserSettingsUpdateInput = {};
    const create: Prisma.UserSettingsUncheckedCreateInput = { userId };
    if (patch.notifTrigger !== undefined) {
      update.notifTrigger = patch.notifTrigger;
      create.notifTrigger = patch.notifTrigger;
    }
    if (patch.keywords !== undefined) {
      // TODO(mention-scan: BullMQ·S45) — 키워드 컬럼 저장만, 실 스캔 미연동.
      update.keywords = patch.keywords;
      create.keywords = patch.keywords;
    }
    if (patch.dndUntil !== undefined) {
      const v = patch.dndUntil ? new Date(patch.dndUntil) : null;
      update.dndUntil = v;
      create.dndUntil = v;
    }
    if (patch.dndSchedule !== undefined) {
      // null 은 Prisma.JsonNull 로 명시해 DB NULL 로 비운다(JS null 직렬화 회피).
      const json: Prisma.InputJsonValue | typeof Prisma.JsonNull =
        patch.dndSchedule === null
          ? Prisma.JsonNull
          : (patch.dndSchedule as unknown as Prisma.InputJsonValue);
      update.dndSchedule = json;
      create.dndSchedule = json;
    }
    await this.prisma.userSettings.upsert({
      where: { userId },
      update,
      create,
    });
    return this.getGlobal(userId);
  }

  // ── 서버 (ServerNotificationPref) ────────────────────────────────────────

  /** 서버 알림 오버라이드 조회. 행이 없으면 기본값(MENTIONS / 비뮤트)을 반환. */
  async getServer(userId: string, workspaceId: string): Promise<ServerNotificationPreference> {
    const row = await this.prisma.serverNotificationPref.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: {
        level: true,
        isMuted: true,
        muteUntil: true,
        suppressEveryone: true,
        suppressRoleMentions: true,
      },
    });
    if (!row) {
      return {
        level: 'MENTIONS',
        isMuted: false,
        muteUntil: null,
        suppressEveryone: false,
        suppressRoleMentions: false,
      };
    }
    return {
      level: row.level,
      isMuted: row.isMuted,
      muteUntil: row.muteUntil ? row.muteUntil.toISOString() : null,
      suppressEveryone: row.suppressEveryone,
      suppressRoleMentions: row.suppressRoleMentions,
    };
  }

  /**
   * 서버 알림 오버라이드 upsert. isMuted=true 면 muteDuration 으로 muteUntil 을
   * 산정한다(미지정 시 영구=null). isMuted=false 면 muteUntil 을 null 로 비운다.
   * suppress* 는 S46 에서 컬럼 저장만(@everyone 게이트 연동은 후속).
   */
  async putServer(
    userId: string,
    workspaceId: string,
    patch: {
      level?: NotifLevel;
      isMuted?: boolean;
      muteDuration?: MuteDurationKey;
      suppressEveryone?: boolean;
      suppressRoleMentions?: boolean;
    },
    now: Date,
  ): Promise<ServerNotificationPreference> {
    const muteUntil =
      patch.isMuted === true
        ? muteUntilFrom(patch.muteDuration, now)
        : patch.isMuted === false
          ? null
          : undefined;
    const update: Prisma.ServerNotificationPrefUpdateInput = {};
    const create: Prisma.ServerNotificationPrefUncheckedCreateInput = { userId, workspaceId };
    if (patch.level !== undefined) {
      update.level = patch.level;
      create.level = patch.level;
    }
    if (patch.isMuted !== undefined) {
      update.isMuted = patch.isMuted;
      create.isMuted = patch.isMuted;
    }
    if (muteUntil !== undefined) {
      update.muteUntil = muteUntil;
      create.muteUntil = muteUntil;
    }
    if (patch.suppressEveryone !== undefined) {
      update.suppressEveryone = patch.suppressEveryone;
      create.suppressEveryone = patch.suppressEveryone;
    }
    if (patch.suppressRoleMentions !== undefined) {
      update.suppressRoleMentions = patch.suppressRoleMentions;
      create.suppressRoleMentions = patch.suppressRoleMentions;
    }
    await this.prisma.serverNotificationPref.upsert({
      where: { userId_workspaceId: { userId, workspaceId } },
      update,
      create,
    });
    return this.getServer(userId, workspaceId);
  }

  /** 서버 뮤트 해제 — isMuted=false, muteUntil=null. 행 부재면 no-op. */
  async unmuteServer(userId: string, workspaceId: string): Promise<ServerNotificationPreference> {
    await this.prisma.serverNotificationPref.updateMany({
      where: { userId, workspaceId },
      data: { isMuted: false, muteUntil: null },
    });
    return this.getServer(userId, workspaceId);
  }

  // ── 채널 (UserChannelMute + level) ───────────────────────────────────────

  /** 채널 알림 오버라이드 조회. 행이 없으면 level=null(상속)/비뮤트. */
  async getChannel(userId: string, channelId: string): Promise<ChannelNotificationPreference> {
    const row = await this.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId, channelId } },
      select: { level: true, mutedUntil: true },
    });
    if (!row) {
      return { level: null, isMuted: false, muteUntil: null };
    }
    // 행 존재 + mutedUntil(null=영구 / 미래)이 곧 채널 뮤트(isMuted). level 만 있고
    // mutedUntil 이 과거면 비뮤트(level 오버라이드만 살아있음).
    const muted = row.mutedUntil === null || row.mutedUntil.getTime() > Date.now();
    // level 만 설정하고 뮤트는 안 한 행을 표현하려면 mutedUntil 이 과거여야 하는데,
    // 그 경우 활성 뮤트 아님. row 존재 자체가 항상 뮤트는 아니다 → muted 플래그로 구분.
    return {
      level: row.level,
      isMuted: muted,
      muteUntil: row.mutedUntil ? row.mutedUntil.toISOString() : null,
    };
  }

  /**
   * 채널 알림 오버라이드 upsert(단일 채널). isMuted=true 면 mutedUntil 을
   * muteDuration 으로 산정(미지정 영구), isMuted=false 면 mutedUntil=null 이되
   * level 오버라이드만 남긴다. level=null 명시 시 서버 상속으로 되돌린다.
   *
   * 주의: 기존 S43 뮤트 UI 는 mutedUntil(행 존재)로 뮤트를 표현한다. 여기서
   * isMuted=false + level=null 을 동시에 보내면 의미 없는 행이 남으므로, 그
   * 경우는 행을 삭제해 깔끔히 정리한다(서버 상속 + 비뮤트 = 행 없음).
   */
  async putChannel(
    userId: string,
    channelId: string,
    patch: { level?: NotifLevel | null; isMuted?: boolean; muteDuration?: MuteDurationKey },
    now: Date,
  ): Promise<ChannelNotificationPreference> {
    const existing = await this.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId, channelId } },
      select: { level: true, mutedUntil: true },
    });
    const nextLevel = patch.level !== undefined ? patch.level : (existing?.level ?? null);
    let nextMutedUntil: Date | null;
    if (patch.isMuted === true) {
      nextMutedUntil = muteUntilFrom(patch.muteDuration, now);
    } else if (patch.isMuted === false) {
      nextMutedUntil = null;
    } else {
      nextMutedUntil = existing?.mutedUntil ?? null;
    }

    // 비뮤트(mutedUntil=null) + level 상속(null) → 의미 없는 행 → 정리.
    if (patch.isMuted === false && nextLevel === null) {
      await this.prisma.userChannelMute.deleteMany({ where: { userId, channelId } });
      return { level: null, isMuted: false, muteUntil: null };
    }

    await this.prisma.userChannelMute.upsert({
      where: { userId_channelId: { userId, channelId } },
      update: { level: nextLevel, mutedUntil: nextMutedUntil },
      create: { userId, channelId, level: nextLevel, mutedUntil: nextMutedUntil },
    });
    return this.getChannel(userId, channelId);
  }

  /**
   * 카테고리 일괄 적용(FR-MN-07): 카테고리 하위 채널 전체에 동일 설정을 bulk
   * upsert 한다. 단일 트랜잭션으로 채널 id 조회 + upsert 를 묶는다. 반환은
   * 영향받은 channelId 목록.
   */
  async putCategoryChannels(
    userId: string,
    categoryId: string,
    patch: { level?: NotifLevel | null; isMuted?: boolean; muteDuration?: MuteDurationKey },
    now: Date,
  ): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const channels = await tx.channel.findMany({
        where: { categoryId, deletedAt: null },
        select: { id: true },
      });
      const nextMutedUntil =
        patch.isMuted === true
          ? muteUntilFrom(patch.muteDuration, now)
          : patch.isMuted === false
            ? null
            : undefined;
      for (const ch of channels) {
        const existing = await tx.userChannelMute.findUnique({
          where: { userId_channelId: { userId, channelId: ch.id } },
          select: { level: true, mutedUntil: true },
        });
        const nextLevel = patch.level !== undefined ? patch.level : (existing?.level ?? null);
        const mutedUntil =
          nextMutedUntil !== undefined ? nextMutedUntil : (existing?.mutedUntil ?? null);
        if (patch.isMuted === false && nextLevel === null) {
          await tx.userChannelMute.deleteMany({
            where: { userId, channelId: ch.id },
          });
          continue;
        }
        await tx.userChannelMute.upsert({
          where: { userId_channelId: { userId, channelId: ch.id } },
          update: { level: nextLevel, mutedUntil },
          create: { userId, channelId: ch.id, level: nextLevel, mutedUntil },
        });
      }
      return channels.map((c) => c.id);
    });
  }

  /** 채널 뮤트 해제 — 행 삭제(level 오버라이드도 함께 제거). 미존재면 idempotent. */
  async unmuteChannel(userId: string, channelId: string): Promise<ChannelNotificationPreference> {
    await this.prisma.userChannelMute.deleteMany({ where: { userId, channelId } });
    return { level: null, isMuted: false, muteUntil: null };
  }
}
