import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { ChannelType, Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import {
  CHANNEL_RESERVED_NAMES,
  CreateChannelRequest,
  MoveChannelRequest,
  UpdateChannelRequest,
  type ChannelPermissionOverride,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { REDIS } from '../redis/redis.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
import { AuditService, AuditAction } from '../common/audit/audit.service';
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
    // S64 (FR-RM12): 채널 권한 오버라이드 설정/해제 + 슬로우모드 변경 감사 기록.
    // @Global AuditModule 제공.
    private readonly audit: AuditService,
    // S62 (FR-RM14): 채널 override 변경 후 권한 캐시(perms:{channelId}:*)를 즉시
    // 무효화한다. @Global RedisModule 제공. 테스트/Redis 부재 시 Optional → no-op.
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  /**
   * S62 (FR-RM14): 채널 권한 캐시 무효화. override(USER/ROLE) 변경 직후 해당 채널의
   * 모든 멤버 캐시 키(`perms:{channelId}:*`)를 DEL 해 ≤300ms 내 반영을 보장한다.
   *
   * SCAN(non-blocking) 으로 매칭 키를 모아 DEL 한다 — KEYS(blocking) 미사용. 채널당
   * 멤버 수는 워크스페이스 규모로 한정되고 override 변경은 저빈도 admin 액션이라
   * 비용이 허용된다. best-effort(Redis 부재/실패 시 다음 호출이 TTL≤5초 후 재계산).
   */
  private async invalidateChannelPermsCache(channelId: string): Promise<void> {
    if (!this.redis) return;
    // ⚠️ ioredis keyPrefix('qufox:')는 GET/SET/DEL 등 key 명령에는 자동 부착되지만
    // SCAN 의 MATCH 패턴 인자에는 부착되지 않는다. 따라서 MATCH 패턴에는 prefix 를
    // 직접 붙여 실제 저장 키(`qufox:perms:...`)를 매칭하고, 반환된 키에서 prefix 를
    // 떼어 DEL 한다(DEL 이 prefix 를 다시 부착하므로). prefix 미설정이면 빈 문자열.
    const prefix = (this.redis.options?.keyPrefix as string | undefined) ?? '';
    const matchPattern = `${prefix}perms:${channelId}:*`;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          // prefix 제거 후 DEL(ioredis 가 DEL 시 prefix 재부착).
          const unprefixed = prefix ? keys.map((k) => k.slice(prefix.length)) : keys;
          await this.redis.del(...unprefixed);
        }
      } while (cursor !== '0');
    } catch {
      // best-effort — 캐시 무효화 실패는 TTL(≤5초)로 자기치유된다.
    }
  }

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
            // S62 (FR-RM03): 커스텀 Role UUID override 도 사이드바 가시성에 반영.
            select: { role: true, memberRoles: { select: { roleId: true } } },
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
              ...(memberRow
                ? [
                    { principalType: 'ROLE', principalId: memberRow.role },
                    // S62 (FR-RM03): 커스텀 Role UUID override.
                    ...memberRow.memberRoles.map((m) => ({
                      principalType: 'ROLE',
                      principalId: m.roleId,
                    })),
                  ]
                : []),
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

  /**
   * 072 백로그 S-D (FR-CH-06): 채널 둘러보기 목록. 공개·비보관·비삭제 채널에 대해
   * 가입(opt-in) 멤버 수 + 호출자 가입 여부를 함께 싣는다.
   *
   * 멤버십 모델: 공개 채널 join 은 USER override 행을 만든다(joinChannel — allow:0/deny:0
   * opt-in 마커). /invite 추가는 allow>0 grant 행을 만든다. 둘 다 "멤버"다. 그러나
   * addChannelMemberOverride(ADMIN)는 공개 채널에도 게이트 없이 *순수 deny 제한*
   * (allow:0 · deny>0) 행을 만들 수 있는데, 이는 "이미 보는 사용자에 대한 제한"이지
   * 가입이 아니다(072 S-D 리뷰 MEDIUM). 따라서 멤버 집계에서 **순수 deny 제한 행
   * (allowMask=0 AND denyMask>0)**을 제외한다 — join 마커(deny=0)와 grant(allow>0)는
   * 포함. (잔여 edge: 가입 후 deny 제한이 걸린 사용자는 제외될 수 있음 — 드묾, 정밀
   * 분리는 별도 멤버십 마커 컬럼 필요·마이그레이션 이월.) leftAt 은 DM 전용이라 일반
   * 채널 override 는 항상 null 이지만 방어적으로 leftAt IS NULL 로 거른다.
   *
   * 사이드바 핫패스(listByWorkspace)는 건드리지 않고 전용 둘러보기 경로에서만 집계한다
   * (groupBy + 호출자 행 조회 2쿼리, 둘 다 인덱스). 보관 채널은 가입 대상이 아니므로
   * 제외한다(S-B 사이드바 숨김과 정합).
   */
  async listBrowsable(workspaceId: string, callerId: string) {
    const channels = await this.prisma.channel.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        archivedAt: null,
        type: { not: 'DIRECT' },
        isPrivate: false,
      },
      orderBy: [{ name: 'asc' }],
    });
    if (channels.length === 0) return { channels: [] };
    const ids = channels.map((c) => c.id);
    // 072 S-D 리뷰(MEDIUM): 순수 deny 제한 행(allow=0 AND deny>0)은 가입이 아니므로 제외.
    const membershipRowWhere = {
      principalType: 'USER' as const,
      leftAt: null,
      NOT: { allowMask: 0, denyMask: { gt: 0 } },
    };
    const [counts, mine] = await Promise.all([
      this.prisma.channelPermissionOverride.groupBy({
        by: ['channelId'],
        where: { channelId: { in: ids }, ...membershipRowWhere },
        _count: { _all: true },
      }),
      this.prisma.channelPermissionOverride.findMany({
        where: { channelId: { in: ids }, principalId: callerId, ...membershipRowWhere },
        select: { channelId: true },
      }),
    ]);
    const countById = new Map(counts.map((c) => [c.channelId, c._count._all]));
    const mineSet = new Set(mine.map((m) => m.channelId));
    return {
      channels: channels.map((c) => ({
        ...this.toDto(c),
        memberCount: countById.get(c.id) ?? 0,
        isMember: mineSet.has(c.id),
      })),
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
              // S61: allow/denyMask 가 BigInt 컬럼이 됐다(Int→BigInt 전환).
              // 비공개 채널 생성자에게 광범위 ALLOW 를 부여하는 표식으로 0xFF 를
              // BigInt 리터럴(0xffn)로 저장한다. 집행 계산은 READ(0x01) 비트만
              // 가시성 게이트에 쓰므로 광범위 allow 가 곧 "생성자=멤버" 표식이다.
              allowMask: 0xffn,
              denyMask: 0n,
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
      // S64 (FR-RM12): slowmodeSeconds 도 읽어 변경 시 SLOWMODE_UPDATE 감사를 남긴다.
      select: { topic: true, isPrivate: true, name: true, slowmodeSeconds: true },
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
        // S64 (FR-RM12): 슬로우모드 간격이 실제로 바뀐 경우에만 감사(같은 tx).
        if (
          input.slowmodeSeconds !== undefined &&
          input.slowmodeSeconds !== before.slowmodeSeconds
        ) {
          await this.audit.record(
            {
              workspaceId,
              actorId,
              action: AuditAction.SLOWMODE_UPDATE,
              channelId,
              details: { from: before.slowmodeSeconds, to: input.slowmodeSeconds },
            },
            tx,
          );
        }
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
    // FR-CH-03 (065): 기본 채널은 삭제할 수 없다. 가입자 랜딩 채널은 항상 존재·접근
    // 가능해야 하므로(없으면 워크스페이스 진입이 깨짐), updateDefaultChannel 로 다른
    // 공개 채널을 기본으로 옮긴 뒤에만 삭제할 수 있다. workspaceId 스코프로 조회해
    // (restore 패턴) 타 워크스페이스 채널 누출을 막고, isDefault 면 409 로 거부한다.
    // ChannelAccessGuard 가 이미 in-workspace 채널을 확인하지만, 가드는 isDefault 를
    // 보지 않으므로 도메인 불변식을 서비스에서 직접 강제한다.
    const target = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
      select: { id: true, isDefault: true },
    });
    if (!target) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
    }
    if (target.isDefault) {
      throw new DomainError(
        ErrorCode.DEFAULT_CHANNEL_PROTECTED,
        '기본 채널은 삭제/보관할 수 없습니다. 먼저 다른 채널을 기본으로 지정하세요.',
      );
    }
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
    // FR-CH-03 (065): 기본 채널은 보관할 수 없다(보관 시 목록에서 사라져 랜딩 불가).
    // softDelete 와 동일하게 workspaceId 스코프로 조회해 isDefault 면 409 로 거부한다.
    const before = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId },
      select: { archivedAt: true, isDefault: true },
    });
    if (!before) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
    }
    if (before.isDefault) {
      throw new DomainError(
        ErrorCode.DEFAULT_CHANNEL_PROTECTED,
        '기본 채널은 삭제/보관할 수 없습니다. 먼저 다른 채널을 기본으로 지정하세요.',
      );
    }
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
    // S64 (FR-RM12): override 설정 액터(감사 기록용). 기존 호출과의 호환을 위해 선택.
    actorId?: string,
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
          // S61: allow/denyMask 가 BigInt 컬럼이 됐다. 컨트롤러가 검증한 number
          // 마스크(≤ enforcement 범위)를 Prisma 경계에서 BigInt 로 승격한다.
          allowMask: BigInt(allowMask),
          denyMask: BigInt(denyMask),
        },
        update: { allowMask: BigInt(allowMask), denyMask: BigInt(denyMask) },
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
      // S64 (FR-RM12): 채널 권한 오버라이드 설정 감사(같은 tx). actorId 미전달 호출은 생략.
      if (actorId) {
        await this.audit.record(
          {
            workspaceId,
            actorId,
            action: AuditAction.CHANNEL_PERMISSION_OVERRIDE_SET,
            targetId: targetUserId,
            channelId,
            details: { principalType: 'USER', allowMask, denyMask },
          },
          tx,
        );
      }
      return { row: upserted, effective: effectiveMask };
    });
    void effective;
    // S62 (FR-RM14): override 변경 직후 권한 캐시 무효화(≤300ms 반영).
    await this.invalidateChannelPermsCache(channelId);
    // S62 (Fork B / ADR-11): allow/denyMask 는 BigInt 컬럼이라 응답에서 string 으로
    // 직렬화한다(BigIntSerializationInterceptor 정합 · S61 555줄 TODO 해소).
    return toOverrideDto(row);
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
    // S61: 시스템 역할 5단계 확장 — ROLE override 의 principalId(시스템 역할 리터럴)
    // 도 5값을 받는다. (커스텀 Role.id UUID override 는 S62 UI 계약 합의 후 도입.)
    role: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST',
    allowMask: number,
    denyMask: number,
    // S64 (FR-RM12): override 설정 액터(감사 기록용). 기존 호출과의 호환을 위해 선택.
    actorId?: string,
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
          // S61: BigInt 컬럼 승격(USER override 와 동일).
          allowMask: BigInt(allowMask),
          denyMask: BigInt(denyMask),
        },
        update: { allowMask: BigInt(allowMask), denyMask: BigInt(denyMask) },
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
      // S64 (FR-RM12): 채널 권한 오버라이드 설정 감사(같은 tx). actorId 미전달 호출은 생략.
      if (actorId) {
        await this.audit.record(
          {
            workspaceId,
            actorId,
            action: AuditAction.CHANNEL_PERMISSION_OVERRIDE_SET,
            channelId,
            details: { principalType: 'ROLE', role, allowMask, denyMask },
          },
          tx,
        );
      }
      return upserted;
    });
    // S62 (FR-RM14): override 변경 직후 권한 캐시 무효화(≤300ms 반영).
    await this.invalidateChannelPermsCache(channelId);
    // S62 (Fork B / ADR-11): string 직렬화.
    return toOverrideDto(row);
  }

  /**
   * S62 (FR-RM14): 채널의 모든 권한 오버라이드(USER + ROLE)를 반환한다. override UI 가
   * 역할/멤버별 3-state(ALLOW/DENY/INHERIT) 토글 현재 상태를 그리는 데 쓴다. DM 가시성
   * 보조 컬럼(visibleFrom 등)은 노출하지 않는다 — 권한 마스크만.
   */
  async listChannelOverrides(
    workspaceId: string,
    channelId: string,
  ): Promise<ChannelPermissionOverride[]> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in workspace');
    }
    const rows = await this.prisma.channelPermissionOverride.findMany({
      where: { channelId },
      select: {
        id: true,
        channelId: true,
        principalType: true,
        principalId: true,
        allowMask: true,
        denyMask: true,
      },
      orderBy: [{ principalType: 'asc' }, { principalId: 'asc' }],
    });
    return rows.map((r) => toOverrideDto(r));
  }

  /**
   * 072 백로그 S-J (FR-RM14): 관리자 override 해제. override 행을 id 로 찾되 **반드시
   * 이 채널 소속**으로 스코프해(cross-channel id 주입 방지) 삭제한다. USER override 를
   * 삭제하면 공개 채널의 opt-in 마커가 사라져(해당 멤버가 사이드바에서 빠지고) 권한 deny
   * 제한이 풀리며, 비공개 채널이면 접근 자체가 회수된다. ROLE override 삭제는 그 역할의
   * 채널 권한이 워크스페이스 역할 권한으로 다시 상속된다.
   *
   * upsert 경로와 동일하게 `channel.permission.changed` 아웃박스 이벤트(removed:true)를
   * 같은 트랜잭션에서 기록하고, 커밋 후 권한 캐시를 무효화한다(≤300ms). 영향 멤버의 채널
   * 구독은 onChannelEvent 가 refreshChannelIdsForWorkspace 로 재조정한다(권한 잃은 소켓
   * 룸 leave — S105 패턴). 액터/대상/해제 직전 마스크를 감사 기록한다.
   */
  async removeChannelOverride(
    workspaceId: string,
    channelId: string,
    overrideId: string,
    actorId?: string,
  ): Promise<{ id: string }> {
    // Channel must live in this workspace (cross-workspace 차단). 보관 채널의
    // override 해제는 허용(컨트롤러가 @AllowArchivedChannel) — deletedAt 만 배제.
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in workspace');
    }
    // override 행을 id + channelId 로 스코프(다른 채널/워크스페이스의 override id 를
    // 받아 삭제하는 IDOR 차단). 미존재 시 404(이미 해제됐거나 잘못된 id).
    const existing = await this.prisma.channelPermissionOverride.findFirst({
      where: { id: overrideId, channelId },
      select: {
        id: true,
        principalType: true,
        principalId: true,
        allowMask: true,
        denyMask: true,
      },
    });
    if (!existing) {
      throw new DomainError(
        ErrorCode.CHANNEL_OVERRIDE_NOT_FOUND,
        'permission override not found in channel',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      // S-J fix-forward (review MEDIUM = 동시 삭제 race): delete 단건 대신 deleteMany 로
      // 삭제한다. 두 요청이 같은 override 를 동시에 지우면 두 번째 tx.delete 는 Prisma
      // P2025 를 던져(DomainExceptionFilter 가 안 잡음 → 500) 비멱등·감사/아웃박스
      // 불일치를 만든다. deleteMany 는 행이 이미 사라졌으면 count=0 을 돌려주므로,
      // count===0 이면 DomainError 를 던져 tx 를 롤백하고 graceful 404 로 응답한다
      // (outbox/audit 미기록 — 첫 요청만 이벤트를 남겨 일관). where 는 id+channelId 스코프.
      const del = await tx.channelPermissionOverride.deleteMany({
        where: { id: existing.id, channelId },
      });
      if (del.count === 0) {
        throw new DomainError(
          ErrorCode.CHANNEL_OVERRIDE_NOT_FOUND,
          'permission override not found in channel',
        );
      }
      await this.outbox.record(tx, {
        aggregateType: 'channel',
        aggregateId: channelId,
        eventType: CHANNEL_PERMISSION_CHANGED,
        payload: {
          workspaceId,
          channelId,
          principalType: existing.principalType,
          ...(existing.principalType === 'USER'
            ? { targetUserId: existing.principalId }
            : { role: existing.principalId }),
          // 해제 → 오버라이드가 사라지므로 effective 는 0(워크스페이스 역할 권한으로 상속).
          allowMask: 0,
          denyMask: 0,
          effectiveMask: 0,
          removed: true,
        },
      });
      if (actorId) {
        await this.audit.record(
          {
            workspaceId,
            actorId,
            action: AuditAction.CHANNEL_PERMISSION_OVERRIDE_REMOVE,
            // USER override 면 대상 사용자, ROLE 면 channelId 만(역할 리터럴은 details).
            targetId: existing.principalType === 'USER' ? existing.principalId : undefined,
            channelId,
            details: {
              principalType: existing.principalType,
              principalId: existing.principalId,
              // 해제 직전 마스크(가역 복원/감사용). BigInt → string(ADR-11).
              allowMask: existing.allowMask.toString(),
              denyMask: existing.denyMask.toString(),
            },
          },
          tx,
        );
      }
    });
    // S62 (FR-RM14): override 변경 직후 권한 캐시 무효화(≤300ms 반영).
    await this.invalidateChannelPermsCache(channelId);
    return { id: existing.id };
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
          // S61: BigInt 컬럼 — opt-in 표식이라 0n.
          allowMask: 0n,
          denyMask: 0n,
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

/**
 * S62 (Fork B / ADR-11): ChannelPermissionOverride row → DTO. allow/denyMask 는
 * BigInt 컬럼이라 string 으로 직렬화한다(BigIntSerializationInterceptor 정합 ·
 * FE 는 BigInt(value) 파싱). principalType 은 'USER' | 'ROLE' 로 좁힌다.
 */
function toOverrideDto(row: {
  id: string;
  channelId: string;
  principalType: string;
  principalId: string;
  allowMask: bigint;
  denyMask: bigint;
}): ChannelPermissionOverride {
  return {
    id: row.id,
    channelId: row.channelId,
    principalType: row.principalType as 'USER' | 'ROLE',
    principalId: row.principalId,
    allowMask: row.allowMask.toString(),
    denyMask: row.denyMask.toString(),
  };
}
