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
  CATEGORY_UPDATED,
} from '../events/channel-events';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.category.findMany({
      where: { workspaceId },
      orderBy: { position: 'asc' },
    });
  }

  async create(workspaceId: string, actorId: string, input: CreateCategoryRequest) {
    const last = await this.prisma.category.findFirst({
      where: { workspaceId },
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
        const result = await tx.category.updateMany({
          where: { id: categoryId, workspaceId },
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

  async remove(workspaceId: string, categoryId: string, actorId: string) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.category.findFirst({
        where: { id: categoryId, workspaceId },
        select: { id: true },
      });
      if (!found) throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
      await tx.category.delete({ where: { id: categoryId } });
      await this.outbox.record(tx, {
        aggregateType: 'category',
        aggregateId: categoryId,
        eventType: CATEGORY_DELETED,
        payload: { workspaceId, actorId, categoryId },
      });
    });
  }

  async move(workspaceId: string, categoryId: string, actorId: string, input: MoveCategoryRequest) {
    return this.prisma.$transaction(async (tx) => {
      // Scope the target category by workspaceId — prevents an ADMIN of
      // workspace A from reordering workspace B's categories.
      const target = await tx.category.findFirst({
        where: { id: categoryId, workspaceId },
        select: { id: true },
      });
      if (!target) {
        throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
      }
      const anchors = await Promise.all([
        input.afterId
          ? tx.category.findFirst({
              where: { id: input.afterId, workspaceId },
              select: { position: true },
            })
          : Promise.resolve(null),
        input.beforeId
          ? tx.category.findFirst({
              where: { id: input.beforeId, workspaceId },
              select: { position: true },
            })
          : Promise.resolve(null),
      ]);
      const [after, before] = anchors;
      let prev = after?.position ?? null;
      let next = before?.position ?? null;
      if (!after && !before) {
        const last = await tx.category.findFirst({
          where: { workspaceId, NOT: { id: categoryId } },
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
