import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateCategoryRequest,
  MoveCategoryRequest,
  UpdateCategoryRequest,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import { calcBetween } from '../positioning/fractional-position';
import {
  CATEGORY_CREATED,
  CATEGORY_DELETED,
  CATEGORY_MOVED,
  CATEGORY_REORDERED,
  CATEGORY_UPDATED,
} from '../events/channel-events';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async list(workspaceId: string) {
    // S15 (FR-CH-12): soft-delete 된 카테고리는 목록에서 제외.
    return this.prisma.category.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { position: 'asc' },
    });
  }

  async create(workspaceId: string, actorId: string, input: CreateCategoryRequest) {
    const last = await this.prisma.category.findFirst({
      where: { workspaceId, deletedAt: null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = calcBetween(last?.position ?? null, null);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cat = await tx.category.create({
          data: {
            workspaceId,
            name: input.name,
            description: input.description ?? null,
            position,
          },
        });
        await this.outbox.record(tx, {
          aggregateType: 'category',
          aggregateId: cat.id,
          eventType: CATEGORY_CREATED,
          payload: {
            workspaceId,
            actorId,
            category: {
              id: cat.id,
              workspaceId: cat.workspaceId,
              name: cat.name,
              description: cat.description,
              position: cat.position.toString(),
            },
          },
        });
        return cat;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(
          ErrorCode.CATEGORY_NAME_TAKEN,
          `category "${input.name}" already exists`,
        );
      }
      throw e;
    }
  }

  async update(
    workspaceId: string,
    categoryId: string,
    actorId: string,
    input: UpdateCategoryRequest,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Cross-workspace IDOR defence: updateMany with workspaceId scope so
        // we can't touch a category that belongs to a different workspace.
        // S15 (FR-CH-12): soft-delete 된 카테고리는 수정 불가(deletedAt:null 한정).
        const result = await tx.category.updateMany({
          where: { id: categoryId, workspaceId, deletedAt: null },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
        });
        if (result.count === 0) {
          throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
        }
        const cat = await tx.category.findUniqueOrThrow({ where: { id: categoryId } });
        await this.outbox.record(tx, {
          aggregateType: 'category',
          aggregateId: cat.id,
          eventType: CATEGORY_UPDATED,
          payload: {
            workspaceId,
            actorId,
            categoryId,
            category: {
              id: cat.id,
              workspaceId: cat.workspaceId,
              name: cat.name,
              description: cat.description,
              position: cat.position.toString(),
            },
          },
        });
        return cat;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(ErrorCode.CATEGORY_NAME_TAKEN, 'category name already taken');
      }
      throw e;
    }
  }

  /**
   * S15 (FR-CH-12): 카테고리 soft-delete. 동일 트랜잭션에서:
   *   1) 소속 채널의 categoryId 를 NULL 로 끊고(채널은 uncategorized 로 이동),
   *   2) 카테고리에 deletedAt 을 찍는다(물리 삭제 아님).
   * 부분 유니크 `(workspaceId, name) WHERE deletedAt IS NULL` 덕분에 삭제 즉시
   * 동명 카테고리를 재생성할 수 있다. 이미 삭제된(또는 없는) 카테고리는
   * CATEGORY_NOT_FOUND.
   */
  async remove(workspaceId: string, categoryId: string, actorId: string) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.category.findFirst({
        where: { id: categoryId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!found) throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
      // 1) 소속 채널의 categoryId 를 NULL 로(같은 트랜잭션). soft-delete 채널은
      //    이미 categoryId 가 의미 없지만 일괄 NULL 로 둬도 무해하다.
      await tx.channel.updateMany({
        where: { workspaceId, categoryId },
        data: { categoryId: null },
      });
      // 2) 카테고리 soft-delete.
      await tx.category.update({
        where: { id: categoryId },
        data: { deletedAt: new Date() },
      });
      await this.outbox.record(tx, {
        aggregateType: 'category',
        aggregateId: categoryId,
        eventType: CATEGORY_DELETED,
        payload: { workspaceId, actorId, categoryId },
      });
    });
  }

  /**
   * S15 (FR-CH-13): 카테고리 배치 재정렬 + 재정규화. 채널 reorderChannels 와
   * 동일한 패턴 — 클라이언트가 보낸 최종 순서대로 1000 등간격으로 재정규화하고
   * 단일 트랜잭션 + SELECT FOR UPDATE 로 동시 재정렬을 직렬화한다. 재정규화 후
   * `categories.reordered` 이벤트에 전체 카테고리 position 목록을 싣는다.
   */
  async reorderCategories(workspaceId: string, actorId: string, ids: string[]) {
    const RENORMALIZE_STRIDE = new Prisma.Decimal('1000');
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "Category"
                   WHERE "workspaceId" = ${workspaceId}::uuid
                     AND "deletedAt" IS NULL
                     AND "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
                   FOR UPDATE`,
      );
      const lockedSet = new Set(locked.map((r) => r.id));
      const applicable = ids.filter((id) => lockedSet.has(id));
      if (applicable.length === 0) {
        throw new DomainError(
          ErrorCode.CATEGORY_NOT_FOUND,
          'no reorderable categories in this workspace',
        );
      }
      let n = 0;
      for (const id of applicable) {
        n += 1;
        await tx.category.update({
          where: { id },
          data: { position: RENORMALIZE_STRIDE.times(n) },
        });
      }
      const categories = await tx.category.findMany({
        where: { workspaceId, deletedAt: null },
        orderBy: { position: 'asc' },
      });
      await this.outbox.record(tx, {
        aggregateType: 'category',
        aggregateId: workspaceId,
        eventType: CATEGORY_REORDERED,
        payload: {
          workspaceId,
          actorId,
          categories: categories.map((c) => ({
            id: c.id,
            position: c.position.toString(),
          })),
        },
      });
      return {
        categories: categories.map((c) => ({
          id: c.id,
          workspaceId: c.workspaceId,
          name: c.name,
          description: c.description,
          position: c.position.toString(),
          createdAt: c.createdAt.toISOString(),
        })),
      };
    });
  }

  async move(workspaceId: string, categoryId: string, actorId: string, input: MoveCategoryRequest) {
    return this.prisma.$transaction(async (tx) => {
      // Scope the target category by workspaceId — prevents an ADMIN of
      // workspace A from reordering workspace B's categories.
      // S15 (FR-CH-12): soft-delete 된 카테고리는 reorder 대상에서 제외.
      const target = await tx.category.findFirst({
        where: { id: categoryId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!target) {
        throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
      }
      const anchors = await Promise.all([
        input.afterId
          ? tx.category.findFirst({
              where: { id: input.afterId, workspaceId, deletedAt: null },
              select: { position: true },
            })
          : Promise.resolve(null),
        input.beforeId
          ? tx.category.findFirst({
              where: { id: input.beforeId, workspaceId, deletedAt: null },
              select: { position: true },
            })
          : Promise.resolve(null),
      ]);
      const [after, before] = anchors;
      let prev = after?.position ?? null;
      let next = before?.position ?? null;
      if (!after && !before) {
        const last = await tx.category.findFirst({
          where: { workspaceId, deletedAt: null, NOT: { id: categoryId } },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        prev = last?.position ?? null;
        next = null;
      }
      const position = calcBetween(prev, next);
      const cat = await tx.category.update({
        where: { id: categoryId },
        data: { position },
      });
      await this.outbox.record(tx, {
        aggregateType: 'category',
        aggregateId: cat.id,
        eventType: CATEGORY_MOVED,
        payload: {
          workspaceId,
          actorId,
          category: {
            id: cat.id,
            workspaceId: cat.workspaceId,
            name: cat.name,
            description: cat.description,
            position: cat.position.toString(),
          },
        },
      });
      return cat;
    });
  }
}
