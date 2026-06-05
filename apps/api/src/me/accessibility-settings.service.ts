import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type AccessibilitySettings,
  DEFAULT_ACCESSIBILITY,
  type UpdateAccessibilitySettings,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';

/**
 * S77a (D14 / FR-PS-12): 접근성 설정 서비스(서버 단일 출처). S76 AppearanceSettingsService
 * 패턴을 그대로 mirror 한다.
 *
 *   - 조회(getAccessibility): UserSettings 행이 없으면 기본값(reduceMotion=false·
 *     highContrast=false)을 반환한다. 읽기만 하므로 행을 생성하지 않는다(첫 PATCH 에서
 *     create-if-not-exists). 행이 없는 false 기본은 "사용자 미설정" 을 뜻하며, 클라/CSS 가
 *     OS prefers-reduced-motion 을 우선 반영한다(FR-PS-12).
 *   - 부분 갱신(updateAccessibility): 전달된 필드만 upsert 한다. 행이 없는 사용자(구 가입자)
 *     도 create 로 행을 만들어 접근성을 저장한다 — 기존 컬럼은 schema default 가 채운다.
 */
@Injectable()
export class AccessibilitySettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 접근성 설정 조회. 행이 없으면 기본값을 반환(행 미생성). */
  async getAccessibility(userId: string): Promise<AccessibilitySettings> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { reduceMotion: true, highContrast: true },
    });
    if (!row) return { ...DEFAULT_ACCESSIBILITY };
    return { reduceMotion: row.reduceMotion, highContrast: row.highContrast };
  }

  /**
   * 접근성 설정 부분 갱신(upsert). 전달된 필드만 갱신하고 나머지는 보존한다. 행이 없으면
   * 새로 만들어 접근성을 저장한다(create-if-not-exists).
   */
  async updateAccessibility(
    userId: string,
    patch: UpdateAccessibilitySettings,
  ): Promise<AccessibilitySettings> {
    const update: Prisma.UserSettingsUpdateInput = {};
    const create: Prisma.UserSettingsUncheckedCreateInput = { userId };

    if (patch.reduceMotion !== undefined) {
      update.reduceMotion = patch.reduceMotion;
      create.reduceMotion = patch.reduceMotion;
    }
    if (patch.highContrast !== undefined) {
      update.highContrast = patch.highContrast;
      create.highContrast = patch.highContrast;
    }

    const row = await this.prisma.userSettings.upsert({
      where: { userId },
      update,
      create,
      select: { reduceMotion: true, highContrast: true },
    });
    return { reduceMotion: row.reduceMotion, highContrast: row.highContrast };
  }
}
