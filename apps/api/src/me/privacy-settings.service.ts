import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FriendReqPolicy as PrismaFriendReqPolicy } from '@prisma/client';
import {
  DEFAULT_PRIVACY,
  type FriendReqPolicy,
  type PrivacySettings,
  type UpdatePrivacySettings,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';

/**
 * S77a (D14 / FR-PS-13): 프라이버시 설정 서비스(서버 단일 출처). S76 AppearanceSettingsService
 * 패턴을 mirror 한다.
 *
 *   - 조회(getPrivacy): UserSettings 행이 없으면 기본값(allowDm=true·messageRequest=true·
 *     allowFriendRequests=EVERYONE)을 반환한다(행 미생성).
 *   - 부분 갱신(updatePrivacy): 전달된 필드만 upsert 한다(create-if-not-exists).
 *
 * ★ 게이트 enforcement 는 본 서비스가 아니라 도메인 서비스에서 이 값을 읽어 강제한다:
 *   - allowDmFromWorkspaceMembers → DirectMessagesService.assertDmPrivacyAllows
 *   - allowFriendRequests         → FriendsService.requestByUsername
 *   - messageRequestEnabled       → message-request 인프라 부재로 저장만(carryover).
 */
@Injectable()
export class PrivacySettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 프라이버시 설정 조회. 행이 없으면 기본값을 반환(행 미생성). */
  async getPrivacy(userId: string): Promise<PrivacySettings> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: {
        allowDmFromWorkspaceMembers: true,
        messageRequestEnabled: true,
        allowFriendRequests: true,
      },
    });
    if (!row) return { ...DEFAULT_PRIVACY };
    return {
      allowDmFromWorkspaceMembers: row.allowDmFromWorkspaceMembers,
      messageRequestEnabled: row.messageRequestEnabled,
      allowFriendRequests: row.allowFriendRequests as FriendReqPolicy,
    };
  }

  /**
   * 프라이버시 설정 부분 갱신(upsert). 전달된 필드만 갱신하고 나머지는 보존한다. 행이 없으면
   * 새로 만들어 저장한다(create-if-not-exists).
   */
  async updatePrivacy(userId: string, patch: UpdatePrivacySettings): Promise<PrivacySettings> {
    const update: Prisma.UserSettingsUpdateInput = {};
    const create: Prisma.UserSettingsUncheckedCreateInput = { userId };

    if (patch.allowDmFromWorkspaceMembers !== undefined) {
      update.allowDmFromWorkspaceMembers = patch.allowDmFromWorkspaceMembers;
      create.allowDmFromWorkspaceMembers = patch.allowDmFromWorkspaceMembers;
    }
    if (patch.messageRequestEnabled !== undefined) {
      update.messageRequestEnabled = patch.messageRequestEnabled;
      create.messageRequestEnabled = patch.messageRequestEnabled;
    }
    if (patch.allowFriendRequests !== undefined) {
      const policy = patch.allowFriendRequests as PrismaFriendReqPolicy;
      update.allowFriendRequests = policy;
      create.allowFriendRequests = policy;
    }

    const row = await this.prisma.userSettings.upsert({
      where: { userId },
      update,
      create,
      select: {
        allowDmFromWorkspaceMembers: true,
        messageRequestEnabled: true,
        allowFriendRequests: true,
      },
    });
    return {
      allowDmFromWorkspaceMembers: row.allowDmFromWorkspaceMembers,
      messageRequestEnabled: row.messageRequestEnabled,
      allowFriendRequests: row.allowFriendRequests as FriendReqPolicy,
    };
  }
}
