import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Density, Theme } from '@prisma/client';
import {
  type AppearanceSettings,
  ChatFontSizeSchema,
  DEFAULT_APPEARANCE,
  type UpdateAppearanceSettings,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S76 (D14 / FR-PS-09): 외관 설정 서비스(서버 단일 출처).
 *
 *   - 조회(getAppearance): UserSettings 행이 없으면 기본값(DARK/COZY/15/false)을 반환.
 *     읽기만 하므로 행을 생성하지 않는다(첫 PATCH 에서 create-if-not-exists).
 *   - 부분 갱신(updateAppearance): 전달된 필드만 upsert 한다. UserSettings 행이 없는
 *     사용자(S46 이전 가입자 등)도 create 로 행을 만들어 외관을 저장한다 — 기존 알림
 *     설정 컬럼(notifTrigger/keywords/...)은 schema default 가 채운다.
 *
 * chatFontSize 는 컨트롤러가 Zod(6단계 union)로 이미 검증하지만, 서비스도 방어적으로
 * 다시 검증해 잘못된 값이 컬럼에 들어가지 않도록 단일 출처를 보강한다(다른 호출 경로 대비).
 */
@Injectable()
export class AppearanceSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 외관 설정 조회. 행이 없으면 기본값을 반환(행 미생성). */
  async getAppearance(userId: string): Promise<AppearanceSettings> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: {
        theme: true,
        density: true,
        chatFontSize: true,
        clock24h: true,
        linkPreviewsEnabled: true,
      },
    });
    if (!row) return { ...DEFAULT_APPEARANCE };
    return this.toView(row);
  }

  /**
   * 외관 설정 부분 갱신(upsert). 전달된 필드만 갱신하고 나머지는 보존한다. 행이 없으면
   * 새로 만들어 외관을 저장한다(create-if-not-exists). chatFontSize 는 6단계만 허용.
   */
  async updateAppearance(
    userId: string,
    patch: UpdateAppearanceSettings,
  ): Promise<AppearanceSettings> {
    const update: Prisma.UserSettingsUpdateInput = {};
    const create: Prisma.UserSettingsUncheckedCreateInput = { userId };

    if (patch.theme !== undefined) {
      update.theme = patch.theme as Theme;
      create.theme = patch.theme as Theme;
    }
    if (patch.density !== undefined) {
      update.density = patch.density as Density;
      create.density = patch.density as Density;
    }
    if (patch.chatFontSize !== undefined) {
      // 방어적 재검증 — 6단계 union 밖이면 거부(컨트롤러 Zod 와 동일 출처).
      const parsed = ChatFontSizeSchema.safeParse(patch.chatFontSize);
      if (!parsed.success) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'invalid chatFontSize (12/13/14/15/16/18)',
        );
      }
      update.chatFontSize = parsed.data;
      create.chatFontSize = parsed.data;
    }
    if (patch.clock24h !== undefined) {
      update.clock24h = patch.clock24h;
      create.clock24h = patch.clock24h;
    }
    if (patch.linkPreviewsEnabled !== undefined) {
      update.linkPreviewsEnabled = patch.linkPreviewsEnabled;
      create.linkPreviewsEnabled = patch.linkPreviewsEnabled;
    }

    // F-P2 (perf MODERATE): upsert 결과를 그대로 toView 로 클램프해 반환한다(이전엔 upsert 후
    // getAppearance 재조회로 2-RTT 였다 — 단일 RTT 로 축소). select 로 외관 5컬럼만 가져온다.
    const row = await this.prisma.userSettings.upsert({
      where: { userId },
      update,
      create,
      select: {
        theme: true,
        density: true,
        chatFontSize: true,
        clock24h: true,
        linkPreviewsEnabled: true,
      },
    });
    return this.toView(row);
  }

  private toView(row: {
    theme: Theme;
    density: Density;
    chatFontSize: number;
    clock24h: boolean;
    linkPreviewsEnabled: boolean;
  }): AppearanceSettings {
    // chatFontSize 가 6단계 밖(예: 외부 변조/구 데이터)이면 기본값으로 클램프해 클라
    // union 타입과 정합시킨다(서버가 항상 유효한 6값만 노출).
    const parsed = ChatFontSizeSchema.safeParse(row.chatFontSize);
    return {
      theme: row.theme,
      density: row.density,
      chatFontSize: parsed.success ? parsed.data : DEFAULT_APPEARANCE.chatFontSize,
      clock24h: row.clock24h,
      linkPreviewsEnabled: row.linkPreviewsEnabled,
    };
  }
}
