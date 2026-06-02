import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { CustomEmojiService, type CustomEmojiListItem } from './custom-emoji.service';

/**
 * S42 (D05 / FR-PK01/PK03/PK04): 이모지 개인화 + 워크스페이스 설정 + 피커 데이터.
 *
 * - UserEmojiPreference: 사용자별 1행(skinTone·퀵반응·최근). PUT /me/emoji-preferences
 *   가 upsert 한다(GET 은 picker-data 에서 read-only 로 합류).
 * - WorkspaceEmojiConfig: 워크스페이스별 1행(퀵반응 기본값·canMemberUpload). PATCH
 *   /workspaces/:wsId/emoji-config 가 upsert 한다.
 * - emoji-picker-data: 위 둘 + 커스텀 이모지(별칭 포함)를 한 응답으로 합친다.
 *   GET 멱등 — 행이 없으면 기본값을 채워 반환하되 upsert 하지 않는다.
 */
export const EMOJI_QUICK_REACTIONS_COUNT = 3;
export const EMOJI_QUICK_REACTION_MAX_LEN = 64;
export const EMOJI_RECENT_CAP = 36;
export const EMOJI_SKIN_TONE_MIN = 1;
export const EMOJI_SKIN_TONE_MAX = 6;
export const EMOJI_DEFAULT_QUICK_REACTIONS = ['👍', '❤️', '😂'] as const;

export interface UserEmojiPreferenceDto {
  defaultSkinTone: number;
  quickReactions: string[];
  recentEmojis: string[];
}

export interface WorkspaceEmojiConfigDto {
  quickReactions: string[];
  canMemberUpload: boolean;
}

export interface EmojiPickerData {
  customEmojis: CustomEmojiListItem[];
  workspaceQuickReactions: string[];
  userQuickReactions: string[] | null;
  recentEmojis: string[];
  defaultSkinTone: number;
}

export interface UpdateUserEmojiPreferenceInput {
  defaultSkinTone?: number;
  quickReactions?: string[];
  recentEmojis?: string[];
}

export interface UpdateWorkspaceEmojiConfigInput {
  quickReactions?: string[];
  canMemberUpload?: boolean;
}

/**
 * Json 컬럼에서 string[] 를 안전하게 읽는다. 형태가 어긋난 legacy/오염 값은 빈
 * 배열로 폴백한다(read-path 가 절대 throw 하지 않게).
 */
function asStringArray(raw: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * quickReactions 검증: 정확히 ≤3개, 각 ≤64자, 모두 비어있지 않은 문자열.
 * (PRD: 3개 고정이지만 부분 입력 허용 — ≤3 으로 두고 3개 초과만 거부한다.)
 */
function validateQuickReactions(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'quickReactions must be an array');
  }
  if (raw.length > EMOJI_QUICK_REACTIONS_COUNT) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `quickReactions must have at most ${EMOJI_QUICK_REACTIONS_COUNT} entries`,
    );
  }
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== 'string' || e.length === 0) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'each quickReaction must be a non-empty string',
      );
    }
    if (e.length > EMOJI_QUICK_REACTION_MAX_LEN) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        `quickReaction too long (max ${EMOJI_QUICK_REACTION_MAX_LEN})`,
      );
    }
    out.push(e);
  }
  return out;
}

function validateRecentEmojis(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'recentEmojis must be an array');
  }
  if (raw.length > EMOJI_RECENT_CAP) {
    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      `recentEmojis must have at most ${EMOJI_RECENT_CAP} entries`,
    );
  }
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== 'string' || e.length === 0) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'each recentEmoji must be a non-empty string',
      );
    }
    if (e.length > EMOJI_QUICK_REACTION_MAX_LEN) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        `recentEmoji too long (max ${EMOJI_QUICK_REACTION_MAX_LEN})`,
      );
    }
    out.push(e);
  }
  return out;
}

@Injectable()
export class EmojiPreferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emojis: CustomEmojiService,
  ) {}

  /**
   * FR-PK03: 사용자 이모지 선호 upsert. skinTone 1-6(422), quickReactions ≤3·각
   * ≤64자, recentEmojis ≤36. 명시된 필드만 갱신하되, 신규 행 생성 시 미명시 필드는
   * 스키마 default 로 채운다. 200 으로 전체 행을 반환한다.
   */
  async updateUserPreference(
    userId: string,
    input: UpdateUserEmojiPreferenceInput,
  ): Promise<UserEmojiPreferenceDto> {
    const update: Prisma.UserEmojiPreferenceUpdateInput = {};
    const create: Prisma.UserEmojiPreferenceCreateInput = {
      user: { connect: { id: userId } },
    };

    if (input.defaultSkinTone !== undefined) {
      const tone = input.defaultSkinTone;
      if (!Number.isInteger(tone) || tone < EMOJI_SKIN_TONE_MIN || tone > EMOJI_SKIN_TONE_MAX) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          `defaultSkinTone must be an integer in [${EMOJI_SKIN_TONE_MIN}, ${EMOJI_SKIN_TONE_MAX}]`,
        );
      }
      update.defaultSkinTone = tone;
      create.defaultSkinTone = tone;
    }
    if (input.quickReactions !== undefined) {
      const qr = validateQuickReactions(input.quickReactions);
      update.quickReactions = qr as unknown as Prisma.InputJsonValue;
      create.quickReactions = qr as unknown as Prisma.InputJsonValue;
    }
    if (input.recentEmojis !== undefined) {
      const re = validateRecentEmojis(input.recentEmojis);
      update.recentEmojis = re as unknown as Prisma.InputJsonValue;
      create.recentEmojis = re as unknown as Prisma.InputJsonValue;
    }

    const row = await this.prisma.userEmojiPreference.upsert({
      where: { userId },
      update,
      create,
    });
    return {
      defaultSkinTone: row.defaultSkinTone,
      quickReactions: asStringArray(row.quickReactions),
      recentEmojis: asStringArray(row.recentEmojis),
    };
  }

  /**
   * FR-PK04: 워크스페이스 이모지 설정 upsert(OWNER/ADMIN — 컨트롤러 @Roles 게이트).
   * quickReactions ≤3·각 ≤64자, canMemberUpload boolean. 200 으로 전체 행 반환.
   */
  async updateWorkspaceConfig(
    workspaceId: string,
    input: UpdateWorkspaceEmojiConfigInput,
  ): Promise<WorkspaceEmojiConfigDto> {
    const update: Prisma.WorkspaceEmojiConfigUpdateInput = {};
    const create: Prisma.WorkspaceEmojiConfigCreateInput = {
      workspace: { connect: { id: workspaceId } },
    };
    if (input.quickReactions !== undefined) {
      const qr = validateQuickReactions(input.quickReactions);
      update.quickReactions = qr as unknown as Prisma.InputJsonValue;
      create.quickReactions = qr as unknown as Prisma.InputJsonValue;
    }
    if (input.canMemberUpload !== undefined) {
      if (typeof input.canMemberUpload !== 'boolean') {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'canMemberUpload must be a boolean');
      }
      update.canMemberUpload = input.canMemberUpload;
      create.canMemberUpload = input.canMemberUpload;
    }
    const row = await this.prisma.workspaceEmojiConfig.upsert({
      where: { workspaceId },
      update,
      create,
    });
    return {
      quickReactions: asStringArray(row.quickReactions),
      canMemberUpload: row.canMemberUpload,
    };
  }

  /**
   * FR-PK01: 피커 초기 데이터. 커스텀 이모지(별칭 포함) + 워크스페이스 퀵반응 기본값
   * + 사용자 퀵반응(없으면 null) + 최근 이모지(≤36) + skinTone 을 한 응답으로 합친다.
   * GET 멱등 — 행이 없으면 기본값을 채워 반환하되 행을 만들지 않는다(upsert 금지).
   */
  async getPickerData(workspaceId: string, userId: string): Promise<EmojiPickerData> {
    const [customEmojis, wsConfig, userPref] = await Promise.all([
      this.emojis.list(workspaceId),
      this.prisma.workspaceEmojiConfig.findUnique({ where: { workspaceId } }),
      this.prisma.userEmojiPreference.findUnique({ where: { userId } }),
    ]);

    const workspaceQuickReactions = wsConfig
      ? asStringArray(wsConfig.quickReactions)
      : [...EMOJI_DEFAULT_QUICK_REACTIONS];
    const userQuickReactions = userPref ? asStringArray(userPref.quickReactions) : null;
    const recentEmojis = userPref ? asStringArray(userPref.recentEmojis) : [];
    const defaultSkinTone = userPref ? userPref.defaultSkinTone : EMOJI_SKIN_TONE_MIN;

    return {
      customEmojis,
      workspaceQuickReactions,
      userQuickReactions,
      recentEmojis,
      defaultSkinTone,
    };
  }
}
