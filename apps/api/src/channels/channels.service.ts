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
  CHANNEL_MEMBER_ADDED,
  CHANNEL_MEMBER_REMOVED,
  CHANNEL_MOVED,
  CHANNEL_PERMISSION_CHANGED,
  CHANNEL_REORDERED,
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
        // S15 (FR-CH-12): soft-delete 된 카테고리는 채널 목록에서 제외.
        where: { workspaceId, deletedAt: null },
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
      // S15 (FR-CH-12): soft-delete 된 카테고리에는 채널을 배치할 수 없다.
      const cat = await this.prisma.category.findFirst({
        where: { id: input.categoryId, workspaceId, deletedAt: null },
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
      // S15 (FR-CH-12): soft-delete 된 카테고리로는 이동 불가.
      const cat = await this.prisma.category.findFirst({
        where: { id: input.categoryId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!cat) {
        throw new DomainError(ErrorCode.CATEGORY_NOT_FOUND, 'category not found');
      }
    }
    // S13 (FR-CH-09): 토픽 변경 시스템 메시지는 "실제로 바뀐 경우"에만 발행한다.
    // 갱신 전 토픽을 읽어 새 값과 비교한다(같은 값으로 PATCH 하면 무발행).
    // S14 (FR-CH-05): 공개/비공개 전환 판단을 위해 현재 isPrivate / name 도 읽는다.
    const before = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { topic: true, isPrivate: true, name: true },
    });
    if (!before) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
    }

    // S14 (FR-CH-05): 공개/비공개 전환 confirm 토큰 검증.
    //   - 비공개(true) → 공개(false) 전환: 파괴적·되돌릴 수 없는 변경이므로
    //     confirmName 이 채널의 현재 name 과 정확히 일치해야 한다(누락/불일치 시
    //     CHANNEL_CONFIRM_REQUIRED). 이전 공유 파일이 전 멤버에게 공개되는 것을
    //     실수로 트리거하지 않도록 하는 서버측 게이트.
    //   - 공개 → 비공개 전환, 또는 isPrivate 미변경 PATCH 에는 토큰 불요.
    const privacyChanging = input.isPrivate !== undefined && input.isPrivate !== before.isPrivate;
    const goingPublic = privacyChanging && input.isPrivate === false;
    if (goingPublic) {
      if (input.confirmName === undefined || input.confirmName !== before.name) {
        throw new DomainError(
          ErrorCode.CHANNEL_CONFIRM_REQUIRED,
          'confirmName must match the channel name to switch a private channel to public',
        );
      }
    }

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
            // S15 (FR-CH-08): slowmodeSeconds — 미지정은 변경 없음, 0 은 비활성화.
            ...(input.slowmodeSeconds !== undefined
              ? { slowmodeSeconds: input.slowmodeSeconds }
              : {}),
            // S51 (FR-PS-05): memberCanPin — 미지정은 변경 없음. true=멤버 전체 허용,
            // false=MODERATOR/ADMIN 이상 제한(pin 게이트가 직접 검사).
            ...(input.memberCanPin !== undefined ? { memberCanPin: input.memberCanPin } : {}),
            // S55 (FR-CH-18): fileUploadEnabled — 미지정은 변경 없음. false 면 upload-url
            // 게이트가 403.
            ...(input.fileUploadEnabled !== undefined
              ? { fileUploadEnabled: input.fileUploadEnabled }
              : {}),
            // S55 (FR-AM-20): maxFileSizeBytes — null 로 채널 오버라이드 해제, 양의 정수로
            // 설정, 미지정은 변경 없음. BigInt 로 영속(컬럼 BIGINT).
            ...(input.maxFileSizeBytes !== undefined
              ? {
                  maxFileSizeBytes:
                    input.maxFileSizeBytes === null ? null : BigInt(input.maxFileSizeBytes),
                }
              : {}),
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
            // S14 (FR-CH-05): isPrivate 전환 반영(confirm 검증은 위에서 끝남).
            ...(privacyChanging ? { isPrivate: input.isPrivate } : {}),
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
        eventType: CHANNEL_PERMISSION_CHANGED,
        payload: {
          workspaceId,
          channelId,
          principalType: 'USER',
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
   * S14 (FR-CH-11): upsert a ROLE-principal override on a channel.
   * principalId is the WorkspaceRole literal (OWNER/ADMIN/MEMBER). The
   * caller route gates on OWNER/ADMIN (@Roles + MANAGE_CHANNEL surface)
   * and bounds the masks against the enforcement bitfield (0xFF) before
   * we get here, mirroring the USER-override path. Emits the same
   * `channel.permission.changed` outbox event so the realtime projection
   * can refresh affected members' channel lists.
   */
  async addChannelRoleOverride(
    workspaceId: string,
    channelId: string,
    role: 'OWNER' | 'ADMIN' | 'MEMBER',
    allowMask: number,
    denyMask: number,
  ) {
    // Channel must live in this workspace (prevents cross-workspace
    // override insertion) and not be soft-deleted.
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in workspace');
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.channelPermissionOverride.upsert({
        where: {
          channelId_principalType_principalId: {
            channelId,
            principalType: 'ROLE',
            principalId: role,
          },
        },
        create: {
          channelId,
          principalType: 'ROLE',
          principalId: role,
          allowMask,
          denyMask,
        },
        update: { allowMask, denyMask },
      });
      const effectiveMask = (allowMask & ~denyMask) >>> 0;
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channelId,
        eventType: CHANNEL_PERMISSION_CHANGED,
        payload: {
          workspaceId,
          channelId,
          principalType: 'ROLE',
          role,
          allowMask,
          denyMask,
          effectiveMask,
        },
      });
      return upserted;
    });
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
   * S14 (FR-CH-07): 채널 가입. 멤버십 모델 결정(REPORT 참조):
   *   - 채널별 멤버십 테이블은 없다. 공개 채널은 workspace 멤버 전원이 자동
   *     가시·접근하므로(listByWorkspace), 공개 채널의 "가입"은 호출자 본인에 대한
   *     USER ALLOW override(opt-in 표식)를 upsert 하는 것으로 표현한다. 이미
   *     접근 가능한 멤버이므로 권한 변동은 없고(allow=ALL_PERMISSIONS·deny=0),
   *     member_added 이벤트로 사이드바/목록 갱신만 트리거한다.
   *   - 비공개 채널은 초대 기반(admin 의 addChannelMemberOverride)만 허용 —
   *     자유 가입 시도는 CHANNEL_PRIVATE_INVITE_ONLY(403) 로 거부한다.
   *
   * 읽기 상태(UserChannelReadState)는 가입으로 생성/삭제하지 않는다(메시지
   * ack 경로가 소유). idempotent: 이미 override 가 있으면 그대로 둔다.
   */
  async joinChannel(workspaceId: string, channelId: string, userId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true, isPrivate: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in workspace');
    }
    if (channel.isPrivate) {
      throw new DomainError(
        ErrorCode.CHANNEL_PRIVATE_INVITE_ONLY,
        'private channels are invite-only — ask an admin to add you',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.channelPermissionOverride.upsert({
        where: {
          channelId_principalType_principalId: {
            channelId,
            principalType: 'USER',
            principalId: userId,
          },
        },
        // review S14 HIGH(privilege escalation) fix: 자유 가입은 **순수 opt-in
        // 표식**(allowMask 0)이다. 공개 채널은 이미 baseline 으로 접근 가능하므로
        // override 가 권한을 더 줄 필요가 없다. 이전 allowMask:0xFF 는 S14 의 5단계
        // (개인 ALLOW > 역할 DENY)와 결합해, MEMBER 가 가입만으로 ADMIN 이 건 역할
        // DENY(예: WRITE_MESSAGE 읽기전용)를 0xFF 로 덮어 권한 상승하는 구멍이었다.
        // allowMask 0 이면 fold 가 비트를 더하지 않아 역할 DENY 가 유지된다.
        create: {
          channelId,
          principalType: 'USER',
          principalId: userId,
          allowMask: 0,
          denyMask: 0,
        },
        update: {},
      });
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channelId,
        eventType: CHANNEL_MEMBER_ADDED,
        payload: { workspaceId, channelId, userId },
      });
    });
    return { channelId, userId };
  }

  /**
   * S14 (FR-CH-07): 채널 탈퇴. 호출자 본인의 USER override 행을 제거한다.
   * 읽기 상태(UserChannelReadState)는 보존한다 — 재가입 시 미읽음 누적이
   * 복원되도록(FR-CH-07 명시 요구). override 가 없으면(=채널 멤버가 아님)
   * CHANNEL_NOT_MEMBER(409). member_removed 이벤트로 사이드바 갱신.
   */
  async leaveChannel(workspaceId: string, channelId: string, userId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in workspace');
    }
    const existing = await this.prisma.channelPermissionOverride.findUnique({
      where: {
        channelId_principalType_principalId: {
          channelId,
          principalType: 'USER',
          principalId: userId,
        },
      },
      select: { id: true },
    });
    if (!existing) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_MEMBER, 'you are not a member of this channel');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.channelPermissionOverride.delete({
        where: {
          channelId_principalType_principalId: {
            channelId,
            principalType: 'USER',
            principalId: userId,
          },
        },
      });
      // 읽기 상태(UserChannelReadState)는 의도적으로 보존 — 삭제하지 않는다.
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channelId,
        eventType: CHANNEL_MEMBER_REMOVED,
        payload: { workspaceId, channelId, userId },
      });
    });
    return { channelId, userId };
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
        // S15 (FR-CH-12): soft-delete 된 카테고리로는 move 불가.
        const cat = await tx.category.findFirst({
          where: { id: nextCategoryId, workspaceId, deletedAt: null },
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

  /**
   * S15 (FR-CH-13): 채널 배치 재정렬 + 재정규화.
   *
   * 클라이언트가 보낸 최종 순서(`items`: id + 목표 categoryId)를 그대로 적용하되,
   * fractional midpoint 누적으로 인접 차가 1e-10 미만으로 수렴(또는 선제존재
   * positioning 오버플로)하는 경우를 근본적으로 피하기 위해 **항상 1000 등간격으로
   * 재정규화**한다. 단일 트랜잭션 + SELECT FOR UPDATE 로 동시 재정렬 레이스를 직렬화한다.
   *
   * 재정규화 후 `channels.reordered` 이벤트에 전체 채널 position 목록을 실어
   * 브로드캐스트한다. 단건 move 와 정합: move 의 fractional midpoint 가 차를 소진하면
   * (CHANNEL_POSITION_INVALID) 클라이언트가 이 배치 경로로 재정규화를 트리거한다.
   *
   * categoryId 별로 독립 시퀀스(1000, 2000, ...)를 부여한다 — 채널 목록은
   * (categoryId asc, position asc) 로 그룹 정렬되므로 카테고리 간 position
   * 충돌은 무의미하다.
   */
  async reorderChannels(
    workspaceId: string,
    actorId: string,
    items: { id: string; categoryId: string | null }[],
  ) {
    const RENORMALIZE_STRIDE = new Prisma.Decimal('1000');
    return this.prisma.$transaction(async (tx) => {
      const ids = items.map((i) => i.id);
      // SELECT FOR UPDATE: 동시 재정렬을 직렬화해 마지막-쓰기-승 + position 단사성 보장.
      // (raw query — Prisma 는 findMany 에 row-lock 을 노출하지 않음.)
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "Channel"
                   WHERE "workspaceId" = ${workspaceId}::uuid
                     AND "deletedAt" IS NULL
                     AND "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
                   FOR UPDATE`,
      );
      const lockedSet = new Set(locked.map((r) => r.id));
      // 잠금된(=이 워크스페이스에 실재하는) 채널만 적용. 모르는 id 는 무시한다
      // (IDOR/stale 클라이언트 방어 — 타 워크스페이스 채널은 lockedSet 에 없다).
      const applicable = items.filter((i) => lockedSet.has(i.id));
      if (applicable.length === 0) {
        throw new DomainError(
          ErrorCode.CHANNEL_NOT_FOUND,
          'no reorderable channels in this workspace',
        );
      }

      // 카테고리별 1000 등간격 시퀀스를 부여한다(items 순서 보존).
      const seqByCategory = new Map<string | null, number>();
      for (const item of applicable) {
        const n = (seqByCategory.get(item.categoryId) ?? 0) + 1;
        seqByCategory.set(item.categoryId, n);
        const position = RENORMALIZE_STRIDE.times(n);
        await tx.channel.update({
          where: { id: item.id },
          data: { position, categoryId: item.categoryId },
        });
      }

      const channels = await tx.channel.findMany({
        where: { workspaceId, deletedAt: null, type: { not: 'DIRECT' } },
        orderBy: [{ categoryId: 'asc' }, { position: 'asc' }],
      });
      const dtos = channels.map((c) => this.toDto(c));
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: workspaceId,
        eventType: CHANNEL_REORDERED,
        payload: {
          workspaceId,
          actorId,
          channels: dtos.map((c) => ({
            id: c.id,
            categoryId: c.categoryId,
            position: c.position,
          })),
        },
      });
      return { channels: dtos };
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
      // S15 (FR-CH-08): 슬로우모드 간격을 DTO 에 노출.
      slowmodeSeconds: c.slowmodeSeconds,
      // S51 (FR-PS-05): 핀 권한 채널 오버라이드를 DTO 에 노출(채널 설정 토글 + pin
      // 버튼 비활성 판단). 기존 row 는 DB default true.
      memberCanPin: c.memberCanPin,
      // S55 (FR-CH-18 / FR-AM-20): 첨부 업로드 토글 + 채널별 크기 상한을 DTO 에 노출.
      fileUploadEnabled: c.fileUploadEnabled,
      maxFileSizeBytes: c.maxFileSizeBytes === null ? null : Number(c.maxFileSizeBytes),
      isPrivate: c.isPrivate,
      archivedAt: c.archivedAt?.toISOString() ?? null,
      deletedAt: c.deletedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
