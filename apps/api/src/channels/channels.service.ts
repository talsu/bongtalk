import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ChannelType, Prisma } from '@prisma/client';
import {
  CHANNEL_RESERVED_NAMES,
  CreateChannelRequest,
  MoveChannelRequest,
  UpdateChannelRequest,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
import { MessagesService } from '../messages/messages.service';
import { calcBetween } from './positioning/fractional-position';
import {
  CHANNEL_ARCHIVED,
  CHANNEL_CREATED,
  CHANNEL_DELETED,
  CHANNEL_MOVED,
  CHANNEL_RESTORED,
  CHANNEL_UNARCHIVED,
  CHANNEL_UPDATED,
} from './events/channel-events';

type ChannelRow = NonNullable<Awaited<ReturnType<PrismaService['channel']['findUnique']>>>;

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    // S13 (FR-CH-09 / FR-CH-04): 토픽 변경·아카이브 시 시스템 메시지를
    // createSystemMessage 로 발행한다. MessagesModule → ChannelsModule
    // 단방향 의존이라 역방향 주입은 forwardRef 로 순환을 끊는다.
    @Inject(forwardRef(() => MessagesService))
    private readonly messages: MessagesService,
  ) {}

  /**
   * S13 (FR-CH-09 / FR-CH-04): 시스템 메시지를 채널에 발행한다. 발행 자체는
   * createSystemMessage 가 자체 트랜잭션으로 처리하므로 도메인 변경
   * 트랜잭션이 커밋된 뒤 호출한다. 시스템 메시지 발행 실패가 도메인 변경
   * (토픽/아카이브)을 롤백시키지 않도록 best-effort 로 감싼다.
   */
  private async emitChannelSystemMessage(args: {
    workspaceId: string;
    channelId: string;
    actorId: string;
    type: 'SYSTEM_CHANNEL_RENAME' | 'SYSTEM_CHANNEL_TOPIC_CHANGED' | 'SYSTEM_CHANNEL_ARCHIVED';
    /** username 은 호출측이 채우지 않아도 actorId 로 해석한다. */
    vars: Record<string, string>;
  }): Promise<void> {
    const actor = await this.prisma.user.findUnique({
      where: { id: args.actorId },
      select: { username: true },
    });
    await this.messages.createSystemMessage({
      workspaceId: args.workspaceId,
      channelId: args.channelId,
      actorId: args.actorId,
      type: args.type,
      vars: { username: actor?.username ?? '', ...args.vars },
    });
  }

  // S12 (FR-CH-01): TEXT / ANNOUNCEMENT / FORUM are the creatable text-surface
  // types. VOICE waits on the voice slice; DIRECT is created only through the
  // DM path, never the workspace channel CRUD — both stay rejected here.
  private static readonly CREATABLE_TYPES: ReadonlySet<ChannelType> = new Set([
    ChannelType.TEXT,
    ChannelType.ANNOUNCEMENT,
    ChannelType.FORUM,
  ]);

  private assertTypeImplemented(type: ChannelType): void {
    if (!ChannelsService.CREATABLE_TYPES.has(type)) {
      throw new DomainError(
        ErrorCode.CHANNEL_TYPE_NOT_IMPLEMENTED,
        `channel type ${type} is not implemented yet`,
      );
    }
  }

  private assertNameAllowed(name: string): void {
    if (CHANNEL_RESERVED_NAMES.has(name)) {
      throw new DomainError(ErrorCode.CHANNEL_NAME_INVALID, `channel name "${name}" is reserved`);
    }
  }

  async listByWorkspace(workspaceId: string, callerId?: string) {
    const [categories, channels, memberRow] = await Promise.all([
      this.prisma.category.findMany({
        where: { workspaceId },
        orderBy: { position: 'asc' },
      }),
      this.prisma.channel.findMany({
        // task-027-B: DIRECT channels belong to the DM inbox, not the
        // workspace channel list. Filter them out at the query level.
        where: { workspaceId, deletedAt: null, type: { not: 'DIRECT' } },
        orderBy: [{ categoryId: 'asc' }, { position: 'asc' }],
      }),
      callerId
        ? this.prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: callerId } },
            select: { role: true },
          })
        : null,
    ]);
    // Task-012-D: filter private channels the caller can't see.
    // Public channels are always visible; private channels require
    // an explicit allow override for this user or role. OWNER sees
    // everything regardless of overrides (ownership is the escape
    // hatch for lost-access scenarios).
    let visibleChannels = channels;
    if (callerId) {
      const privateIds = channels.filter((c) => c.isPrivate).map((c) => c.id);
      let overrideHits: Set<string> | null = null;
      if (privateIds.length > 0 && memberRow?.role !== 'OWNER') {
        const rows = await this.prisma.channelPermissionOverride.findMany({
          where: {
            channelId: { in: privateIds },
            allowMask: { gt: 0 },
            OR: [
              { principalType: 'USER', principalId: callerId },
              ...(memberRow ? [{ principalType: 'ROLE', principalId: memberRow.role }] : []),
            ],
          },
          select: { channelId: true },
        });
        overrideHits = new Set(rows.map((r) => r.channelId));
      }
      visibleChannels = channels.filter((c) => {
        if (!c.isPrivate) return true;
        if (memberRow?.role === 'OWNER') return true;
        return overrideHits?.has(c.id) ?? false;
      });
    }
    const byCat = new Map<string | null, typeof visibleChannels>();
    for (const c of visibleChannels) {
      const key = c.categoryId;
      const list = byCat.get(key) ?? [];
      list.push(c);
      byCat.set(key, list);
    }
    return {
      categories: categories.map((cat) => ({
        id: cat.id,
        workspaceId: cat.workspaceId,
        name: cat.name,
        description: cat.description,
        position: cat.position.toString(),
        createdAt: cat.createdAt.toISOString(),
        channels: (byCat.get(cat.id) ?? []).map((c) => this.toDto(c)),
      })),
      uncategorized: (byCat.get(null) ?? []).map((c) => this.toDto(c)),
    };
  }

  async create(
    workspaceId: string,
    actorId: string,
    input: CreateChannelRequest,
  ): Promise<ChannelRow> {
    this.assertNameAllowed(input.name);
    this.assertTypeImplemented(input.type as ChannelType);

    if (input.categoryId) {
      const cat = await this.prisma.category.findFirst({
        where: { id: input.categoryId, workspaceId },
        select: { id: true },
      });
      if (!cat) {
        throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
      }
    }

    // Place at the end of its category (or uncategorized bucket).
    const last = await this.prisma.channel.findFirst({
      where: {
        workspaceId,
        categoryId: input.categoryId ?? null,
        deletedAt: null,
      },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = calcBetween(last?.position ?? null, null);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const channel = await tx.channel.create({
          data: {
            workspaceId,
            name: input.name,
            type: input.type as ChannelType,
            topic: input.topic ?? null,
            // S13 (FR-CH-10): 설명은 생성 시 선택 입력.
            description: input.description ?? null,
            categoryId: input.categoryId ?? null,
            position,
            // Task-012-D: honour the isPrivate flag from the DTO.
            // Default-false in the schema keeps public-by-default.
            isPrivate: input.isPrivate ?? false,
          },
        });
        // Task-012 reviewer MED-6: when creating a private channel,
        // seed a USER-principal override for the creator with the full
        // role baseline so the creator can actually reach their own
        // channel. Without this, OWNER could create but not access
        // without a subsequent POST /members. Applies for every role
        // (the channel creator should always have access).
        if (channel.isPrivate) {
          await tx.channelPermissionOverride.upsert({
            where: {
              channelId_principalType_principalId: {
                channelId: channel.id,
                principalType: 'USER',
                principalId: actorId,
              },
            },
            create: {
              channelId: channel.id,
              principalType: 'USER',
              principalId: actorId,
              // ALL_PERMISSIONS = 0xFF across the 8 slots (see
              // permissions.ts). Hard-coded so we don't cross-import
              // and pull in a web surface from the core service layer.
              allowMask: 0xff,
              denyMask: 0,
            },
            update: {},
          });
        }
        await this.outbox.record(tx, {
          aggregateType: 'channel',
          aggregateId: channel.id,
          eventType: CHANNEL_CREATED,
          payload: {
            workspaceId,
            actorId,
            channel: this.toDto(channel),
          },
        });
        return channel;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(
          ErrorCode.CHANNEL_NAME_TAKEN,
          `channel "${input.name}" already exists`,
        );
      }
      throw e;
    }
  }

  async update(
    workspaceId: string,
    channelId: string,
    actorId: string,
    input: UpdateChannelRequest,
  ) {
    if (input.name !== undefined) this.assertNameAllowed(input.name);
    if (input.categoryId !== undefined && input.categoryId !== null) {
      const cat = await this.prisma.category.findFirst({
        where: { id: input.categoryId, workspaceId },
        select: { id: true },
      });
      if (!cat) {
        throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
      }
    }
    // S13 (FR-CH-09): 토픽 변경 시스템 메시지는 "실제로 바뀐 경우"에만 발행한다.
    // 갱신 전 토픽을 읽어 새 값과 비교한다(같은 값으로 PATCH 하면 무발행).
    const before = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { topic: true },
    });
    let channel: ChannelRow;
    try {
      channel = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.channel.update({
          where: { id: channelId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.topic !== undefined ? { topic: input.topic } : {}),
            // S13 (FR-CH-10): description — null 은 삭제, 미지정은 변경 없음.
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          },
        });
        await this.outbox.record(tx, {
          aggregateType: 'channel',
          aggregateId: updated.id,
          eventType: CHANNEL_UPDATED,
          payload: { workspaceId, actorId, channel: this.toDto(updated) },
        });
        return updated;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(ErrorCode.CHANNEL_NAME_TAKEN, 'channel name already taken');
      }
      throw e;
    }
    // S13 (FR-CH-09): channel.updated 이벤트는 위에서 그대로 유지. 토픽이 실제로
    // 바뀌었으면 추가로 SYSTEM_CHANNEL_TOPIC_CHANGED 시스템 메시지를 발행한다.
    // 트랜잭션 커밋 뒤 호출(createSystemMessage 가 자체 트랜잭션).
    if (input.topic !== undefined && (before?.topic ?? null) !== (input.topic ?? null)) {
      await this.emitChannelSystemMessage({
        workspaceId,
        channelId,
        actorId,
        type: 'SYSTEM_CHANNEL_TOPIC_CHANGED',
        vars: { topic: input.topic ?? '' },
      });
    }
    return channel;
  }

  async softDelete(workspaceId: string, channelId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const channel = await tx.channel.update({
        where: { id: channelId },
        data: { deletedAt: new Date() },
      });
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channel.id,
        eventType: CHANNEL_DELETED,
        payload: { workspaceId, actorId, channelId },
      });
      return channel;
    });
  }

  async restore(workspaceId: string, channelId: string, actorId: string) {
    // Scope the lookup by workspaceId so an ADMIN of workspace A can't
    // restore workspace B's channel just because the `restore` route
    // skips ChannelAccessGuard to reach soft-deleted rows.
    const current = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
      select: { id: true, deletedAt: true },
    });
    if (!current) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
    }
    if (!current.deletedAt) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel is not deleted');
    }
    return this.prisma.$transaction(async (tx) => {
      const channel = await tx.channel.update({
        where: { id: channelId },
        data: { deletedAt: null },
      });
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channel.id,
        eventType: CHANNEL_RESTORED,
        payload: {
          workspaceId,
          actorId,
          channelId,
          channel: this.toDto(channel),
        },
      });
      return channel;
    });
  }

  async archive(workspaceId: string, channelId: string, actorId: string) {
    // S13 (FR-CH-04): 이미 보관 상태면 시스템 메시지를 중복 발행하지 않는다.
    const before = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { archivedAt: true },
    });
    const channel = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.channel.update({
        where: { id: channelId },
        data: { archivedAt: new Date() },
      });
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: updated.id,
        eventType: CHANNEL_ARCHIVED,
        payload: { workspaceId, actorId, channelId },
      });
      return updated;
    });
    // S13 (FR-CH-04): 보관 전환 시 SYSTEM_CHANNEL_ARCHIVED 시스템 메시지 발행.
    if (!before?.archivedAt) {
      await this.emitChannelSystemMessage({
        workspaceId,
        channelId,
        actorId,
        type: 'SYSTEM_CHANNEL_ARCHIVED',
        vars: {},
      });
    }
    return channel;
  }

  async unarchive(workspaceId: string, channelId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const channel = await tx.channel.update({
        where: { id: channelId },
        data: { archivedAt: null },
      });
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channel.id,
        eventType: CHANNEL_UNARCHIVED,
        payload: { workspaceId, actorId, channelId },
      });
      return channel;
    });
  }

  /**
   * Task-012-D: upsert a USER-principal override on a channel.
   * Returns the resulting row.
   */
  async addChannelMemberOverride(
    workspaceId: string,
    channelId: string,
    targetUserId: string,
    allowMask: number,
    denyMask: number,
  ) {
    // Both-in-workspace gate: the target has to be a member of this
    // workspace for a per-user channel override to be meaningful.
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { userId: true },
    });
    if (!target) {
      throw new DomainError(
        ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
        'target user is not a member of this workspace',
      );
    }
    // Channel must live in this workspace (prevents cross-workspace
    // override insertion).
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in workspace');
    }
    // Task-012 reviewer MED-7 fix: emit `channel.permission.changed`
    // outbox event in the same $transaction as the upsert so the
    // realtime dispatcher can refresh the target user's channel list
    // without them reloading. Payload carries workspaceId +
    // channelId + targetUserId + effective mask; the WS projection
    // routes via rooms.user(targetUserId).
    const { row, effective } = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.channelPermissionOverride.upsert({
        where: {
          channelId_principalType_principalId: {
            channelId,
            principalType: 'USER',
            principalId: targetUserId,
          },
        },
        create: {
          channelId,
          principalType: 'USER',
          principalId: targetUserId,
          allowMask,
          denyMask,
        },
        update: { allowMask, denyMask },
      });
      const effectiveMask = (allowMask & ~denyMask) >>> 0;
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channelId,
        eventType: 'channel.permission.changed',
        payload: {
          workspaceId,
          channelId,
          targetUserId,
          allowMask,
          denyMask,
          effectiveMask,
        },
      });
      return { row: upserted, effective: effectiveMask };
    });
    void effective;
    return {
      id: row.id,
      channelId: row.channelId,
      principalType: row.principalType,
      principalId: row.principalId,
      allowMask: row.allowMask,
      denyMask: row.denyMask,
    };
  }

  /**
   * Reorder a channel. `beforeId` / `afterId` anchor the target position;
   * `categoryId` (null = uncategorized) optionally moves the channel between
   * categories. If both anchors are null we append to the end.
   */
  async move(workspaceId: string, channelId: string, actorId: string, input: MoveChannelRequest) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.channel.findFirst({
        where: { id: channelId, workspaceId, deletedAt: null },
        select: { id: true, categoryId: true },
      });
      if (!current) {
        throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
      }

      const nextCategoryId = input.categoryId !== undefined ? input.categoryId : current.categoryId;

      if (nextCategoryId) {
        const cat = await tx.category.findFirst({
          where: { id: nextCategoryId, workspaceId },
          select: { id: true },
        });
        if (!cat) {
          throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
        }
      }

      const anchors = await Promise.all([
        input.afterId
          ? tx.channel.findFirst({
              where: { id: input.afterId, workspaceId, deletedAt: null },
              select: { id: true, position: true, categoryId: true },
            })
          : Promise.resolve(null),
        input.beforeId
          ? tx.channel.findFirst({
              where: { id: input.beforeId, workspaceId, deletedAt: null },
              select: { id: true, position: true, categoryId: true },
            })
          : Promise.resolve(null),
      ]);
      const [after, before] = anchors;

      // prev/next positions relative to (nextCategoryId).
      let prev = after?.position ?? null;
      let next = before?.position ?? null;
      if (!after && !before) {
        const last = await tx.channel.findFirst({
          where: {
            workspaceId,
            categoryId: nextCategoryId,
            deletedAt: null,
            NOT: { id: channelId },
          },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        prev = last?.position ?? null;
        next = null;
      }

      const position = calcBetween(prev, next);

      const channel = await tx.channel.update({
        where: { id: channelId },
        data: { position, categoryId: nextCategoryId ?? null },
      });
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channel.id,
        eventType: CHANNEL_MOVED,
        payload: { workspaceId, actorId, channel: this.toDto(channel) },
      });
      return channel;
    });
  }

  /** Single-channel DTO for routes that already have a loaded row. */
  async toPublicDto(channelId: string) {
    const c = await this.prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    return this.toDto(c);
  }

  private toDto(c: ChannelRow) {
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      categoryId: c.categoryId,
      name: c.name,
      type: c.type,
      topic: c.topic,
      // S13 (FR-CH-10): 설명을 채널 목록/단건 DTO 에 노출.
      description: c.description,
      position: c.position.toString(),
      isPrivate: c.isPrivate,
      archivedAt: c.archivedAt?.toISOString() ?? null,
      deletedAt: c.deletedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
