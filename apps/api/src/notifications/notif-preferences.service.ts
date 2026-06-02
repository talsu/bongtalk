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
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S48 (FR-MN-10): 사용자당 키워드 알림 등록 상한. PRD 정본 — 26번째 등록 시도 시
 * 400(KEYWORD_LIMIT_EXCEEDED). 서비스 레이어가 단일 출처로 enforce 한다(Zod 의
 * 형태 검증과 분리 — 한도 초과는 전용 errorCode 로 구별해 클라이언트 토스트 분기).
 */
export const KEYWORD_MAX_COUNT = 25;
/** 키워드 1개 길이 상한(글자 수). 공백 어절 일치라 과도하게 긴 입력 방지용. */
const KEYWORD_MAX_LENGTH = 100;

/**
 * S48 (FR-MN-10): 키워드 배열 정규화 + 검증.
 *   - 각 키워드 trim. 빈/공백 → VALIDATION_FAILED. 길이 초과(>100) → VALIDATION_FAILED.
 *   - 대소문자 무관 중복 제거(첫 출현 보존). 매칭이 대소문자 무관이므로 저장도 dedupe.
 *   - 최종 개수 > 25 → KEYWORD_LIMIT_EXCEEDED.
 */
function normalizeKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw) {
    const trimmed = k.trim();
    if (trimmed.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'keyword must not be blank');
    }
    if (trimmed.length > KEYWORD_MAX_LENGTH) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        `keyword too long (max ${KEYWORD_MAX_LENGTH})`,
      );
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  if (out.length > KEYWORD_MAX_COUNT) {
    throw new DomainError(
      ErrorCode.KEYWORD_LIMIT_EXCEEDED,
      `too many keywords (max ${KEYWORD_MAX_COUNT})`,
    );
  }
  return out;
}

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
   *
   * S48:
   *   - keywords: 최대 25개(KEYWORD_LIMIT_EXCEEDED) + trim/비공백/길이(≤100) 검증 +
   *     대소문자 무관 중복 제거. **실 스캔은 미구현** — 컬럼 저장만.
   *     TODO(mention-scan: MentionRecord + 동기/BullMQ — S45 인프라 결정 후).
   *   - dndUntil(FR-MN-11 임시 snooze): 과거 시각은 거부(VALIDATION_FAILED, 최소
   *     now+1분). null = 해제.
   *
   * @param now dndUntil 과거 거부 판정 기준(주입 — 테스트 결정성).
   */
  async updateGlobal(
    userId: string,
    patch: {
      notifTrigger?: NotifLevel;
      keywords?: string[];
      dndUntil?: string | null;
      dndSchedule?: DndSchedule | null;
    },
    now: Date = new Date(),
  ): Promise<GlobalNotificationSettings> {
    const update: Prisma.UserSettingsUpdateInput = {};
    const create: Prisma.UserSettingsUncheckedCreateInput = { userId };
    if (patch.notifTrigger !== undefined) {
      update.notifTrigger = patch.notifTrigger;
      create.notifTrigger = patch.notifTrigger;
    }
    if (patch.keywords !== undefined) {
      // FR-MN-10: 서비스 레이어 검증(25개 한도 + 정규화). 실 스캔은 미연동.
      // TODO(mention-scan: MentionRecord + 동기/BullMQ — S45 인프라 결정 후) —
      //   mention:keyword 이벤트·MentionRecord 미생성(키워드 컬럼 저장만).
      const normalized = normalizeKeywords(patch.keywords);
      update.keywords = normalized;
      create.keywords = normalized;
    }
    if (patch.dndUntil !== undefined) {
      const v = patch.dndUntil ? new Date(patch.dndUntil) : null;
      // FR-MN-11: 과거 snooze 종료 시각은 무의미 → 거부(최소 now+1분). null=해제는 허용.
      if (v !== null && v.getTime() <= now.getTime() + 60_000) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'dndUntil must be at least 1 minute in the future',
        );
      }
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

  /**
   * 채널 알림 오버라이드 조회. 행이 없으면 level=null(상속)/비뮤트. `now` 를
   * 주입받아 만료 판정을 결정적으로 한다(gate 의 now 와 정합 — Date.now() 제거).
   */
  async getChannel(
    userId: string,
    channelId: string,
    now: Date,
  ): Promise<ChannelNotificationPreference> {
    const row = await this.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId, channelId } },
      select: { level: true, mutedUntil: true, isMuted: true },
    });
    if (!row) {
      return { level: null, isMuted: false, muteUntil: null };
    }
    // S46 fix-forward (BLOCKER 3): 활성 채널 뮤트 = isMuted && (mutedUntil null=영구
    // | mutedUntil>now). isMuted=false 이면 level 오버라이드만 살아있는 비뮤트 행.
    const muted =
      row.isMuted && (row.mutedUntil === null || row.mutedUntil.getTime() > now.getTime());
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
      select: { level: true, mutedUntil: true, isMuted: true },
    });
    const nextLevel = patch.level !== undefined ? patch.level : (existing?.level ?? null);
    // S46 fix-forward (BLOCKER 3): isMuted 를 명시 축으로 set. 뮤트 경로(isMuted=true)는
    // isMuted=true + mutedUntil 산정, level-only 경로(isMuted=false)는 isMuted=false +
    // mutedUntil=null(레벨만 오버라이드). 미지정이면 기존 값 보존.
    let nextIsMuted: boolean;
    let nextMutedUntil: Date | null;
    if (patch.isMuted === true) {
      nextIsMuted = true;
      nextMutedUntil = muteUntilFrom(patch.muteDuration, now);
    } else if (patch.isMuted === false) {
      nextIsMuted = false;
      nextMutedUntil = null;
    } else {
      nextIsMuted = existing?.isMuted ?? false;
      nextMutedUntil = existing?.mutedUntil ?? null;
    }

    // 비뮤트 + level 상속(null) → 의미 없는 행 → 정리(서버 상속 + 비뮤트 = 행 없음).
    if (!nextIsMuted && nextLevel === null) {
      await this.prisma.userChannelMute.deleteMany({ where: { userId, channelId } });
      return { level: null, isMuted: false, muteUntil: null };
    }

    await this.prisma.userChannelMute.upsert({
      where: { userId_channelId: { userId, channelId } },
      update: { level: nextLevel, mutedUntil: nextMutedUntil, isMuted: nextIsMuted },
      create: {
        userId,
        channelId,
        level: nextLevel,
        mutedUntil: nextMutedUntil,
        isMuted: nextIsMuted,
      },
    });
    return this.getChannel(userId, channelId, now);
  }

  /**
   * 카테고리 일괄 적용(FR-MN-07): 카테고리 하위 채널 전체에 동일 설정을 bulk
   * upsert 한다. 단일 트랜잭션으로 채널 id 조회 + upsert 를 묶는다. 반환은
   * 영향받은 channelId 목록.
   *
   * S46 fix-forward (BLOCKER 2): `workspaceId` 로 카테고리 채널을 스코프한다 —
   * 타 워크스페이스 categoryId 로 채널을 조작하거나 채널 ID 를 열거(IDOR)하는
   * 경로를 막는다. categoryId 가 해당 워크스페이스 소속이 아니면 빈 결과가 되어
   * 아무것도 바뀌지 않는다. 추가로 기존 UserChannelMute 행을 findMany(channelId
   * in [...])로 일괄 조회해 per-channel findUnique 루프(N+1)를 제거한다.
   */
  async putCategoryChannels(
    userId: string,
    workspaceId: string,
    categoryId: string,
    patch: { level?: NotifLevel | null; isMuted?: boolean; muteDuration?: MuteDurationKey },
    now: Date,
  ): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      // BLOCKER 2: workspaceId 필터로 IDOR/채널 ID 열거 차단.
      const channels = await tx.channel.findMany({
        where: { categoryId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (channels.length === 0) return [];
      const channelIds = channels.map((c) => c.id);

      // N+1 제거: 기존 행을 일괄 조회 후 메모리 맵으로 fold.
      const existingRows = await tx.userChannelMute.findMany({
        where: { userId, channelId: { in: channelIds } },
        select: { channelId: true, level: true, mutedUntil: true, isMuted: true },
      });
      const existingByChannel = new Map(existingRows.map((r) => [r.channelId, r]));

      const idsToDelete: string[] = [];
      const upserts: Array<{
        channelId: string;
        level: NotifLevel | null;
        mutedUntil: Date | null;
        isMuted: boolean;
      }> = [];

      for (const channelId of channelIds) {
        const existing = existingByChannel.get(channelId);
        const nextLevel = patch.level !== undefined ? patch.level : (existing?.level ?? null);
        let nextIsMuted: boolean;
        let nextMutedUntil: Date | null;
        if (patch.isMuted === true) {
          nextIsMuted = true;
          nextMutedUntil = muteUntilFrom(patch.muteDuration, now);
        } else if (patch.isMuted === false) {
          nextIsMuted = false;
          nextMutedUntil = null;
        } else {
          nextIsMuted = existing?.isMuted ?? false;
          nextMutedUntil = existing?.mutedUntil ?? null;
        }
        if (!nextIsMuted && nextLevel === null) {
          idsToDelete.push(channelId);
          continue;
        }
        upserts.push({
          channelId,
          level: nextLevel,
          mutedUntil: nextMutedUntil,
          isMuted: nextIsMuted,
        });
      }

      // 정리 대상 일괄 삭제(deleteMany 1쿼리).
      if (idsToDelete.length > 0) {
        await tx.userChannelMute.deleteMany({
          where: { userId, channelId: { in: idsToDelete } },
        });
      }
      // upsert 는 (userId,channelId) 충돌 의미가 있어 per-row 가 불가피하나, 위 N+1
      // 조회는 이미 제거했다. (Prisma 는 partial-conflict upsert 의 batch 미지원.)
      for (const u of upserts) {
        await tx.userChannelMute.upsert({
          where: { userId_channelId: { userId, channelId: u.channelId } },
          update: { level: u.level, mutedUntil: u.mutedUntil, isMuted: u.isMuted },
          create: {
            userId,
            channelId: u.channelId,
            level: u.level,
            mutedUntil: u.mutedUntil,
            isMuted: u.isMuted,
          },
        });
      }
      return channelIds;
    });
  }

  /**
   * 채널 뮤트 해제. S46 fix-forward (HIGH): server unmute 처럼 **level 오버라이드를
   * 보존**한다(이전엔 행을 통째 삭제해 level 유실). isMuted=false·mutedUntil=null 로
   * 뮤트만 해제하되 level 은 유지하고, level=null(상속)이면 의미 없는 행이라 삭제한다.
   * 행 부재면 idempotent.
   */
  async unmuteChannel(
    userId: string,
    channelId: string,
    now: Date,
  ): Promise<ChannelNotificationPreference> {
    const existing = await this.prisma.userChannelMute.findUnique({
      where: { userId_channelId: { userId, channelId } },
      select: { level: true },
    });
    if (!existing) {
      return { level: null, isMuted: false, muteUntil: null };
    }
    if (existing.level === null) {
      // 상속 level + 뮤트 해제 = 흔적 없음 → 행 삭제.
      await this.prisma.userChannelMute.deleteMany({ where: { userId, channelId } });
      return { level: null, isMuted: false, muteUntil: null };
    }
    // level 오버라이드 보존, 뮤트만 해제.
    await this.prisma.userChannelMute.update({
      where: { userId_channelId: { userId, channelId } },
      data: { isMuted: false, mutedUntil: null },
    });
    return this.getChannel(userId, channelId, now);
  }
}
