import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateSidebarSectionRequest,
  MoveSidebarChannelRequest,
  MoveSidebarSectionRequest,
  UpdateSidebarSectionRequest,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { calcBetween } from '../positioning/fractional-position';

/**
 * S85 (FR-CH-16): 사이드바 개인 섹션 서비스.
 *
 * 정책(S43 즐겨찾기 서비스 일반화):
 *  - 모든 행은 개인 상태다 — (userId) 로 스코프하며 각자 자기 섹션·할당만 본다.
 *    컨트롤러가 WorkspaceMemberGuard 로 워크스페이스 멤버임을 선검증한다.
 *  - 섹션/채널 순서는 fractional position(calcBetween, Decimal 20,10)으로 둔다.
 *    신규는 말단 append(calcBetween(last, null)), 재정렬은 즐겨찾기 move 와 동일한
 *    anchor 규약(beforeId/afterId, 둘 다 없으면 말단)을 따른다.
 *  - 채널 할당은 (userId, channelId) @@unique 라 채널은 사용자당 한 섹션에만 속한다.
 *    이미 다른 섹션에 있으면 새 섹션으로 옮긴다(멱등 upsert).
 *  - 채널 할당 시 그 채널이 해당 워크스페이스 소속(비삭제)인지 검증한다(없으면
 *    CHANNEL_NOT_FOUND). 비공개 채널 가시성 ACL 은 본 슬라이스 범위 밖이다(개인
 *    사이드바 정리이며, 비가시 채널은 사이드바 채널 목록에 애초에 노출되지 않는다).
 */

export type SectionRow = {
  id: string;
  workspaceId: string;
  name: string;
  emoji: string | null;
  sortMode: 'MANUAL' | 'ALPHABETICAL';
  position: Prisma.Decimal;
  createdAt: Date;
  channelIds: string[];
};

@Injectable()
export class SidebarSectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 워크스페이스 내 사용자 섹션 전체 + 각 섹션 channelIds(position asc). */
  async list(userId: string, workspaceId: string): Promise<SectionRow[]> {
    const sections = await this.prisma.userSidebarSection.findMany({
      where: { userId, workspaceId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        emoji: true,
        sortMode: true,
        position: true,
        createdAt: true,
        assignments: {
          orderBy: { position: 'asc' },
          select: { channelId: true },
        },
      },
    });
    return sections.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      name: s.name,
      emoji: s.emoji,
      sortMode: s.sortMode,
      position: s.position,
      createdAt: s.createdAt,
      channelIds: s.assignments.map((a) => a.channelId),
    }));
  }

  /** 섹션 생성 — position 은 사용자(+워크스페이스) 목록 말단. */
  async create(
    userId: string,
    workspaceId: string,
    input: CreateSidebarSectionRequest,
  ): Promise<SectionRow> {
    const last = await this.prisma.userSidebarSection.findFirst({
      where: { userId, workspaceId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = calcBetween(last?.position ?? null, null);
    const row = await this.prisma.userSidebarSection.create({
      data: {
        userId,
        workspaceId,
        name: input.name,
        emoji: input.emoji ?? null,
        sortMode: input.sortMode ?? 'MANUAL',
        position,
      },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        emoji: true,
        sortMode: true,
        position: true,
        createdAt: true,
      },
    });
    return { ...row, channelIds: [] };
  }

  /** 섹션 이름/이모지/정렬방식 부분 갱신. 본인 섹션이 아니면 404. */
  async update(
    userId: string,
    workspaceId: string,
    sectionId: string,
    input: UpdateSidebarSectionRequest,
  ): Promise<SectionRow> {
    await this.requireSection(userId, workspaceId, sectionId);
    const data: Prisma.UserSidebarSectionUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.emoji !== undefined) data.emoji = input.emoji;
    if (input.sortMode !== undefined) data.sortMode = input.sortMode;
    await this.prisma.userSidebarSection.update({
      where: { id: sectionId },
      data,
    });
    return this.getSection(userId, workspaceId, sectionId);
  }

  /**
   * 섹션 삭제. 할당 행은 onDelete Cascade 로 함께 정리되며, 그 채널들은 사이드바
   * 카테고리 기본 위치로 자연 복귀한다(클라가 미할당 채널을 기본 위치에 렌더).
   * 본인 섹션이 아니면 404.
   */
  async remove(userId: string, workspaceId: string, sectionId: string): Promise<void> {
    await this.requireSection(userId, workspaceId, sectionId);
    await this.prisma.userSidebarSection.delete({ where: { id: sectionId } });
  }

  /**
   * 섹션 재정렬. 즐겨찾기 move 와 동일하게 beforeId/afterId 가 목표 위치를 고정하고,
   * 둘 다 없으면 말단으로 간주한다. anchor 는 같은 사용자(+워크스페이스)의 다른 섹션
   * id 여야 한다(아니면 404). self-reference anchor 는 거부한다.
   */
  async moveSection(
    userId: string,
    workspaceId: string,
    sectionId: string,
    input: MoveSidebarSectionRequest,
  ): Promise<SectionRow> {
    if (input.afterId === sectionId || input.beforeId === sectionId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'anchor must reference a different section',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.userSidebarSection.findFirst({
        where: { id: sectionId, userId, workspaceId },
        select: { id: true },
      });
      if (!current) {
        throw new DomainError(ErrorCode.SIDEBAR_SECTION_NOT_FOUND, 'section not found');
      }

      const [after, before] = await Promise.all([
        input.afterId
          ? tx.userSidebarSection.findFirst({
              where: { id: input.afterId, userId, workspaceId },
              select: { position: true },
            })
          : Promise.resolve(null),
        input.beforeId
          ? tx.userSidebarSection.findFirst({
              where: { id: input.beforeId, userId, workspaceId },
              select: { position: true },
            })
          : Promise.resolve(null),
      ]);

      if (input.afterId && !after) {
        throw new DomainError(ErrorCode.SIDEBAR_SECTION_NOT_FOUND, 'afterId anchor not found');
      }
      if (input.beforeId && !before) {
        throw new DomainError(ErrorCode.SIDEBAR_SECTION_NOT_FOUND, 'beforeId anchor not found');
      }

      let prev = after?.position ?? null;
      let next = before?.position ?? null;
      if (!after && !before) {
        const last = await tx.userSidebarSection.findFirst({
          where: { userId, workspaceId, NOT: { id: sectionId } },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        prev = last?.position ?? null;
        next = null;
      }

      const position = calcBetween(prev, next);
      await tx.userSidebarSection.update({ where: { id: sectionId }, data: { position } });
    });
    return this.getSection(userId, workspaceId, sectionId);
  }

  /**
   * 채널을 섹션에 할당(멱등 upsert). 채널이 이미 다른 섹션에 있으면 이 섹션으로 옮긴다.
   * position 은 목표 섹션 말단. 채널이 워크스페이스 소속(비삭제)이 아니면 CHANNEL_NOT_FOUND,
   * 섹션이 본인 소유가 아니면 SIDEBAR_SECTION_NOT_FOUND.
   */
  async assignChannel(
    userId: string,
    workspaceId: string,
    sectionId: string,
    channelId: string,
  ): Promise<SectionRow> {
    await this.requireSection(userId, workspaceId, sectionId);
    await this.requireWorkspaceChannel(workspaceId, channelId);

    await this.prisma.$transaction(async (tx) => {
      const last = await tx.userSidebarChannelAssignment.findFirst({
        where: { userId, sectionId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const position = calcBetween(last?.position ?? null, null);
      await tx.userSidebarChannelAssignment.upsert({
        where: { userId_channelId: { userId, channelId } },
        update: { sectionId, position },
        create: { userId, channelId, sectionId, position },
      });
    });
    return this.getSection(userId, workspaceId, sectionId);
  }

  /**
   * 채널 할당 해제 — 행 삭제(채널은 사이드바 기본 위치로 복귀). 미존재면 idempotent.
   * 섹션이 본인 소유가 아니면 404.
   */
  async unassignChannel(
    userId: string,
    workspaceId: string,
    sectionId: string,
    channelId: string,
  ): Promise<SectionRow> {
    await this.requireSection(userId, workspaceId, sectionId);
    await this.prisma.userSidebarChannelAssignment.deleteMany({
      where: { userId, sectionId, channelId },
    });
    return this.getSection(userId, workspaceId, sectionId);
  }

  /**
   * 섹션 내 채널 재정렬 + 섹션 간 이동. sectionId 가 주어지면 그 섹션으로 옮긴다
   * (미지정이면 현재 섹션 유지). beforeId/afterId 는 목표 섹션 안의 다른 채널 id 다
   * (anchor 미존재 시 SIDEBAR_ASSIGNMENT_NOT_FOUND, 둘 다 없으면 목표 섹션 말단).
   */
  async moveChannel(
    userId: string,
    workspaceId: string,
    channelId: string,
    input: MoveSidebarChannelRequest,
  ): Promise<SectionRow> {
    if (input.afterId === channelId || input.beforeId === channelId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'anchor must reference a different channel',
      );
    }
    const targetSectionId = await this.prisma.$transaction(async (tx) => {
      const current = await tx.userSidebarChannelAssignment.findFirst({
        where: { userId, channelId },
        select: { id: true, sectionId: true },
      });
      if (!current) {
        throw new DomainError(
          ErrorCode.SIDEBAR_ASSIGNMENT_NOT_FOUND,
          'channel assignment not found',
        );
      }

      // S85 리뷰 fix-forward (LOW-1): 현재 할당의 섹션이 path workspaceId 소속인지 먼저
      // 검증한다. (userId, channelId) 는 글로벌 유니크라, 다중 워크스페이스 멤버가 워크스페이스
      // B 에 할당한 채널을 path /workspaces/A/.. 로 이동 요청하면 종전엔 B 행에 position 을 쓴
      // 뒤 getSection(A) 단계에서야 404 가 나(본인 데이터지만 commit-then-404 무결성 냄새),
      // 어느 write 도 일어나기 전에 거부한다. sectionId 미지정 경로의 누락된 workspace 스코프
      // 를 보강한다(섹션 reorder 는 이미 (userId, workspaceId) 스코프).
      const currentSection = await tx.userSidebarSection.findFirst({
        where: { id: current.sectionId, userId, workspaceId },
        select: { id: true },
      });
      if (!currentSection) {
        throw new DomainError(ErrorCode.SIDEBAR_SECTION_NOT_FOUND, 'section not found');
      }

      // 목표 섹션 결정: sectionId 가 주어지면 본인 소유인지 확인 후 그 섹션, 아니면 현재.
      let sectionId = current.sectionId;
      if (input.sectionId && input.sectionId !== current.sectionId) {
        const dest = await tx.userSidebarSection.findFirst({
          where: { id: input.sectionId, userId, workspaceId },
          select: { id: true },
        });
        if (!dest) {
          throw new DomainError(ErrorCode.SIDEBAR_SECTION_NOT_FOUND, 'target section not found');
        }
        sectionId = input.sectionId;
      }

      const [after, before] = await Promise.all([
        input.afterId
          ? tx.userSidebarChannelAssignment.findFirst({
              where: { userId, sectionId, channelId: input.afterId },
              select: { position: true },
            })
          : Promise.resolve(null),
        input.beforeId
          ? tx.userSidebarChannelAssignment.findFirst({
              where: { userId, sectionId, channelId: input.beforeId },
              select: { position: true },
            })
          : Promise.resolve(null),
      ]);

      if (input.afterId && !after) {
        throw new DomainError(ErrorCode.SIDEBAR_ASSIGNMENT_NOT_FOUND, 'afterId anchor not found');
      }
      if (input.beforeId && !before) {
        throw new DomainError(ErrorCode.SIDEBAR_ASSIGNMENT_NOT_FOUND, 'beforeId anchor not found');
      }

      let prev = after?.position ?? null;
      let next = before?.position ?? null;
      if (!after && !before) {
        const last = await tx.userSidebarChannelAssignment.findFirst({
          where: { userId, sectionId, NOT: { channelId } },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        prev = last?.position ?? null;
        next = null;
      }

      const position = calcBetween(prev, next);
      await tx.userSidebarChannelAssignment.update({
        where: { userId_channelId: { userId, channelId } },
        data: { sectionId, position },
      });
      return sectionId;
    });
    return this.getSection(userId, workspaceId, targetSectionId);
  }

  // ── 내부 헬퍼 ────────────────────────────────────────────────────────────────

  /** 섹션이 본인 소유(+워크스페이스 일치)인지 확인. 아니면 404. */
  private async requireSection(
    userId: string,
    workspaceId: string,
    sectionId: string,
  ): Promise<void> {
    const found = await this.prisma.userSidebarSection.findFirst({
      where: { id: sectionId, userId, workspaceId },
      select: { id: true },
    });
    if (!found) {
      throw new DomainError(ErrorCode.SIDEBAR_SECTION_NOT_FOUND, 'section not found');
    }
  }

  /** 채널이 해당 워크스페이스 소속(비삭제)인지 확인. 아니면 CHANNEL_NOT_FOUND. */
  private async requireWorkspaceChannel(workspaceId: string, channelId: string): Promise<void> {
    const ch = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!ch) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in workspace');
    }
  }

  /** 단일 섹션 + channelIds 재조회(mutate 응답용). */
  private async getSection(
    userId: string,
    workspaceId: string,
    sectionId: string,
  ): Promise<SectionRow> {
    const rows = await this.list(userId, workspaceId);
    const found = rows.find((s) => s.id === sectionId);
    if (!found) {
      throw new DomainError(ErrorCode.SIDEBAR_SECTION_NOT_FOUND, 'section not found');
    }
    return found;
  }
}
