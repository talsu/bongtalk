import { Inject, Injectable } from '@nestjs/common';
import type { SlashCommandItem } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { buildBuiltinCommands } from './builtin-commands';

/**
 * S79 (D15 / FR-SC-01·02) — 슬래시 커맨드 목록 서비스.
 *
 * GET /workspaces/:workspaceId/slash-commands 의 백엔드. 빌트인 상수
 * (BUILTIN_COMMANDS, `/giphy` 는 GIPHY_API_KEY env 게이트)와 워크스페이스
 * SlashCommand 테이블의 enabled 커스텀 행을 병합해 반환한다.
 *
 * 병합 규칙:
 *   - 빌트인이 먼저, 커스텀이 뒤(자동완성 클라 필터가 빌트인 우선 정렬을 다시 하므로
 *     순서는 안정성/결정성 목적).
 *   - 같은 name 의 커스텀이 빌트인을 가리지 않는다(S79 는 단순 concat — 충돌 시 둘 다
 *     노출하되 isBuiltin 으로 구분). 워크스페이스 내 커스텀끼리는 @@unique([workspaceId,name])
 *     로 DB 가 중복을 막는다.
 *
 * 실행(POST execute)은 S79 범위 외이다 — 본 서비스는 목록 GET 만 제공한다(S80 실행).
 */
@Injectable()
export class SlashCommandService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** GIPHY 빌트인 노출 여부. env 키가 비어 있지 않으면 활성. */
  private giphyEnabled(): boolean {
    return (process.env.GIPHY_API_KEY ?? '').trim().length > 0;
  }

  /**
   * 워크스페이스에서 사용 가능한 슬래시 커맨드 목록(빌트인 상수 + DB 커스텀).
   * 자동완성 팝업이 이 목록을 받아 클라이언트에서 퍼지 필터한다.
   */
  async list(workspaceId: string): Promise<SlashCommandItem[]> {
    const builtins = buildBuiltinCommands(this.giphyEnabled());
    const custom = await this.prisma.slashCommand.findMany({
      where: { workspaceId, enabled: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        usageHint: true,
        responseType: true,
        handlerType: true,
      },
    });
    const customItems: SlashCommandItem[] = custom.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      usageHint: c.usageHint,
      responseType: c.responseType,
      handlerType: c.handlerType,
      isBuiltin: false,
    }));
    return [...builtins, ...customItems];
  }
}
