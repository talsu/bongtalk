import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { Permission } from '../../auth/permissions';
import { OutboxService } from '../../common/outbox/outbox.service';
import type { OutboxTxClient } from '../../common/outbox/outbox.types';
import { DM_CREATED } from '../events/channel-events';

const DM_ALLOW_MASK =
  Permission.READ |
  Permission.WRITE_MESSAGE |
  Permission.DELETE_OWN_MESSAGE |
  Permission.UPLOAD_ATTACHMENT;

// S16 (FR-DM-02): 그룹 DM 구성원 상한 — 본인 포함 ≤20 (= 본인 외 2~19명).
const GROUP_DM_MAX_TOTAL = 20;

export interface DmParticipantProfile {
  userId: string;
  username: string;
}

export interface DmListItem {
  channelId: string;
  otherUserId: string;
  otherUsername: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  // S16 (FR-DM-03): 미리보기용 참여자 프로필(상대방 측). 1:1 DM 목록(list)에서는
  // 본인 제외 상대 1명이라 **항상 정확히 1개 요소**다. 그룹 목록(listGroups)이
  // 같은 shape 으로 ≤5 슬라이스를 싣는다. 헤더/아바타 스택이 멤버 set 일관 렌더.
  participants: DmParticipantProfile[];
}

/**
 * task-027-A: Direct Message channel management. DMs live in the same
 * Channel table with type=DIRECT + isPrivate=true; membership is
 * expressed as two USER-level ChannelPermissionOverride rows
 * (ALLOW READ|WRITE|DELETE_OWN|UPLOAD). Idempotent createOrGet keeps
 * the pair → channel mapping 1:1 via a deterministic name slug built
 * from the sorted userId pair.
 */
@Injectable()
export class DirectMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * S16 (FR-DM-16): DM·그룹 DM 개설 시 outbox 에 `dm.created` 를 기록한다.
   * 생성 트랜잭션과 같은 commit 에 row 가 보이도록 tx 안에서 호출한다. recipients
   * 는 **outbox→WS 라우팅 전용**(각 user:{userId} 룸으로 fanout 할 대상)이며 outbox
   * payload 에만 남는다. 와이어로 나가는 `dm:created` 페이로드에는 참여자 UUID 전체
   * 노출을 막기 위해 구독자가 recipients 를 제거한 뒤 emit 한다(H-03 참조).
   */
  private async recordDmCreated(
    tx: OutboxTxClient,
    args: { channelId: string; participantIds: string[]; isGroup: boolean },
  ): Promise<void> {
    await this.outbox.record(tx, {
      aggregateType: 'channel',
      aggregateId: args.channelId,
      eventType: DM_CREATED,
      payload: {
        channelId: args.channelId,
        isGroup: args.isGroup,
        participantIds: args.participantIds,
        // 라우팅 전용: 모든 참여자에게 push — 개설자 본인 탭도 다른 디바이스에서
        // 목록을 갱신한다. 와이어 emit 페이로드에서는 구독자가 이 필드를 제거한다.
        recipients: args.participantIds,
      },
    });
  }

  /**
   * S16 (BLOCKER fix-forward): 전역(workspace 없는) DM·그룹 DM 의 친구 게이트.
   * `meId` 와 `otherId` 사이에 ACCEPTED friendship 이 없으면(미친구·BLOCKED·
   * 본인) 거부한다. createOrGetGlobal(1:1) 과 createGroupDm(global) 이 공유한다.
   *
   * 차단 여부 비노출(H-03): 미친구와 차단을 **동일 status + 동일 중립 메시지**로
   * 거부한다. status code(FRIEND_NOT_FOUND → 404)는 기존 1:1 계약을 유지하되
   * 메시지만 중립화해 상대의 차단/친구 상태를 추론할 수 없게 한다.
   */
  private async assertCanDm(meId: string, otherId: string): Promise<void> {
    if (meId === otherId) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'cannot DM yourself');
    }
    const friendship = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: meId, addresseeId: otherId },
          { requesterId: otherId, addresseeId: meId },
        ],
      },
      select: { status: true },
    });
    if (!friendship || friendship.status !== 'ACCEPTED') {
      // blocked·not-friend 모두 동일 status + 동일 중립 메시지(차단 여부 비노출).
      throw new DomainError(ErrorCode.FRIEND_NOT_FOUND, 'cannot DM: not permitted');
    }
  }

  private channelName(a: string, b: string): string {
    const [x, y] = [a, b].sort();
    return `dm:${x}:${y}`;
  }

  /**
   * task-045 iter5: Group DM (3+) naming. 모든 멤버 (sender 포함)
   * userId 를 정렬 후 join — 동일 멤버 set 은 동일 slug → idempotent
   * createOrGet 보장. S16 (FR-DM-02): cap 20명 (20 × 36 = 720 chars +
   * prefix → Channel.name 은 unbounded text 라 길이 충분).
   *
   * 주의: participantHash 별도 컬럼 없이 이 slug + 부분 유니크 인덱스가 1:1 DM
   * 중복을 막는다. 그룹도 마찬가지로 `gdm:` slug 가 `Channel_global_dm_name_uniq`
   * 에 걸리므로 **동일 구성원 set 은 dedup 된다** — createGroupDm 이 기존 채널을
   * 반환(created:false)하는 idempotent 동작이다. FR-DM-02 의 duplicates-allowed
   * 의도와는 편차가 있으나(true-duplicate 의미 결정은 carryover), 현재 동작은
   * 동일 set 재생성 시 기존 채널 반환이다. 그룹 DM 은 cap 만 추가로 강제한다.
   */
  private groupChannelName(memberIds: string[]): string {
    return `gdm:${[...memberIds].sort().join(':')}`;
  }

  /**
   * task-045 iter5: Group DM 생성 또는 기존 같은 멤버 set 채널 반환.
   *
   * 검증:
   * - memberIds (sender 제외 다른 사용자) 2-19 명 (총 3-20, FR-DM-02)
   * - 본인 (meId) 가 memberIds 에 들어있으면 거부 — 클라이언트 실수 방지
   * - 모두 unique
   * - workspaceId 가 주어지면 모든 멤버가 그 워크스페이스 멤버
   *
   * 결과: createOrGet 패턴. 같은 멤버 set 이 이미 존재하면 그 채널을
   * 그대로 반환. permission override 는 1:1 DM 과 같은 USER ALLOW 마스크.
   */
  async createGroupDm(args: {
    workspaceId: string | null;
    meId: string;
    memberIds: string[];
  }): Promise<{ channelId: string; created: boolean; memberIds: string[] }> {
    const { workspaceId, meId, memberIds } = args;
    if (memberIds.length < 2) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'group DM requires at least 2 other members',
      );
    }
    // S16 (FR-DM-02): 본인 포함 ≤20 → 본인 외 ≤19. 초과 시 422 (DM_GROUP_CAP_EXCEEDED).
    if (memberIds.length > GROUP_DM_MAX_TOTAL - 1) {
      throw new DomainError(
        ErrorCode.DM_GROUP_CAP_EXCEEDED,
        `group DM cap exceeded (max ${GROUP_DM_MAX_TOTAL} total)`,
      );
    }
    if (memberIds.some((id) => id === meId)) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'memberIds must not include yourself');
    }
    const uniqueIds = new Set(memberIds);
    if (uniqueIds.size !== memberIds.length) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'memberIds must be unique');
    }
    const allMembers = [meId, ...memberIds];
    if (workspaceId !== null) {
      const wsMembers = await this.prisma.workspaceMember.findMany({
        where: { workspaceId, userId: { in: allMembers } },
        select: { userId: true },
      });
      const wsSet = new Set(wsMembers.map((m) => m.userId));
      for (const id of allMembers) {
        if (!wsSet.has(id)) {
          throw new DomainError(
            ErrorCode.WORKSPACE_NOT_MEMBER,
            'all members must belong to the workspace',
          );
        }
      }
    } else {
      // S16 (BLOCKER fix-forward): 전역 그룹 DM 은 워크스페이스 멤버십 게이트가
      // 없으므로 각 멤버에 대해 친구 게이트를 강제한다. 미친구·차단 사용자를
      // 임의 userId 로 그룹에 강제 편입시키는 harassment 경로를 차단한다.
      for (const memberId of memberIds) {
        await this.assertCanDm(meId, memberId);
      }
    }

    const name = this.groupChannelName(allMembers);
    const existing = await this.prisma.channel.findFirst({
      where: { workspaceId, name, type: 'DIRECT', deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      return { channelId: existing.id, created: false, memberIds: allMembers };
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const ch = await tx.channel.create({
          data: {
            workspaceId,
            name,
            type: 'DIRECT',
            isPrivate: true,
            topic: null,
            position: 0,
            categoryId: null,
          },
        });
        for (const uid of allMembers) {
          await tx.channelPermissionOverride.create({
            data: {
              channelId: ch.id,
              principalType: 'USER',
              principalId: uid,
              allowMask: DM_ALLOW_MASK,
              denyMask: 0,
            },
          });
        }
        // S16 (FR-DM-16): 같은 commit 에 dm.created 기록 → 멤버 전원 룸으로 fanout.
        await this.recordDmCreated(tx as unknown as OutboxTxClient, {
          channelId: ch.id,
          participantIds: allMembers,
          isGroup: true,
        });
        return ch;
      });
      return { channelId: created.id, created: true, memberIds: allMembers };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        const winner = await this.prisma.channel.findFirst({
          where: { workspaceId, name, type: 'DIRECT', deletedAt: null },
          select: { id: true },
        });
        if (winner) {
          return { channelId: winner.id, created: false, memberIds: allMembers };
        }
      }
      throw err;
    }
  }

  async createOrGet(
    workspaceId: string,
    meId: string,
    otherUserId: string,
  ): Promise<{ channelId: string; created: boolean }> {
    if (meId === otherUserId) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'cannot DM yourself');
    }
    // Both users must be workspace members (task-027 contract).
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: [meId, otherUserId] } },
      select: { userId: true },
    });
    const memberSet = new Set(members.map((m) => m.userId));
    if (!memberSet.has(meId) || !memberSet.has(otherUserId)) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'target is not a workspace member');
    }

    const name = this.channelName(meId, otherUserId);
    const existing = await this.prisma.channel.findFirst({
      where: { workspaceId, name, type: 'DIRECT', deletedAt: null },
      select: { id: true },
    });
    if (existing) return { channelId: existing.id, created: false };

    // Transaction: new Channel + two ChannelPermissionOverride rows.
    // task-027 reviewer H1: two concurrent POSTs for the same pair race
    // the findFirst→create gap. Channel has @@unique([workspaceId, name])
    // so the loser hits P2002 on the DB; catch and re-run findFirst so
    // the caller gets the winner's channelId instead of a 500.
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const ch = await tx.channel.create({
          data: {
            workspaceId,
            name,
            type: 'DIRECT',
            isPrivate: true,
            topic: null,
            position: 0,
            categoryId: null,
          },
        });
        for (const uid of [meId, otherUserId]) {
          await tx.channelPermissionOverride.create({
            data: {
              channelId: ch.id,
              principalType: 'USER',
              principalId: uid,
              allowMask: DM_ALLOW_MASK,
              denyMask: 0,
            },
          });
        }
        // S16 (FR-DM-16): 같은 commit 에 dm.created 기록.
        await this.recordDmCreated(tx as unknown as OutboxTxClient, {
          channelId: ch.id,
          participantIds: [meId, otherUserId],
          isGroup: false,
        });
        return ch;
      });
      return { channelId: created.id, created: true };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        const winner = await this.prisma.channel.findFirst({
          where: { workspaceId, name, type: 'DIRECT', deletedAt: null },
          select: { id: true },
        });
        if (winner) return { channelId: winner.id, created: false };
      }
      throw err;
    }
  }

  /**
   * task-045 iter8: 사용자가 멤버인 group DM 목록 (3+ members).
   * naming convention `gdm:` prefix 로 group 만 필터. 1:1 DM 은
   * 기존 list() 가 처리.
   *
   * 정렬: 최근 메시지 desc, 메시지 없으면 channel.createdAt desc.
   */
  async listGroups(
    workspaceId: string | null,
    meId: string,
    limit = 50,
  ): Promise<
    Array<{
      channelId: string;
      memberIds: string[];
      // S16 (FR-DM-03): 미리보기용 멤버 프로필(≤5, username 정렬). 1:1 list() 와
      // 동일 shape 으로 헤더/아바타 스택이 멤버 set 을 일관 렌더한다. memberIds 는
      // 전체 id 집합(권한·라우팅용), participants 는 ≤5 표시용 슬라이스.
      participants: DmParticipantProfile[];
      lastMessageAt: string | null;
      lastMessagePreview: string | null;
      createdAt: string;
    }>
  > {
    const capped = Math.max(1, Math.min(100, limit));
    type Row = {
      channelId: string;
      memberIds: string[];
      lastMessageAt: Date | null;
      lastMessagePreview: string | null;
      createdAt: Date;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      WITH my_groups AS (
        SELECT c.id AS "channelId", c."createdAt"
          FROM "Channel" c
          JOIN "ChannelPermissionOverride" mine
            ON mine."channelId" = c.id
           AND mine."principalType" = 'USER'
           AND mine."principalId" = ${meId}::text
           AND (mine."allowMask" & 1) > 0
         WHERE (${workspaceId}::uuid IS NULL OR c."workspaceId" = ${workspaceId}::uuid)
           AND c.type = 'DIRECT'
           AND c.name LIKE 'gdm:%'
           AND c."deletedAt" IS NULL
      ),
      members AS (
        SELECT mg."channelId",
               ARRAY_AGG(peer."principalId" ORDER BY peer."principalId") AS "memberIds"
          FROM my_groups mg
          JOIN "ChannelPermissionOverride" peer
            ON peer."channelId" = mg."channelId"
           AND peer."principalType" = 'USER'
         GROUP BY mg."channelId"
      ),
      last_msg AS (
        SELECT DISTINCT ON (m."channelId")
               m."channelId",
               m."createdAt"           AS "lastMessageAt",
               LEFT(m."contentPlain", 140) AS "lastMessagePreview"
          FROM "Message" m
          JOIN my_groups mg ON mg."channelId" = m."channelId"
         WHERE m."deletedAt" IS NULL
         ORDER BY m."channelId", m."createdAt" DESC
      )
      SELECT mg."channelId",
             m."memberIds",
             lm."lastMessageAt",
             lm."lastMessagePreview",
             mg."createdAt"
        FROM my_groups mg
        JOIN members m ON m."channelId" = mg."channelId"
        LEFT JOIN last_msg lm ON lm."channelId" = mg."channelId"
       ORDER BY COALESCE(lm."lastMessageAt", mg."createdAt") DESC
       LIMIT ${capped}
    `;
    if (rows.length === 0) return [];
    // S16 (FR-DM-03): 표시용 멤버 username 을 ≤5 로 조회. 전체 멤버 id 를 모아
    // 한 번에 User 를 조회한 뒤 채널별로 (정렬·≤5) 슬라이스한다.
    const allMemberIds = Array.from(new Set(rows.flatMap((r) => r.memberIds)));
    const users = await this.prisma.user.findMany({
      where: { id: { in: allMemberIds } },
      select: { id: true, username: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.username]));
    return rows.map((r) => ({
      channelId: r.channelId,
      memberIds: r.memberIds,
      participants: r.memberIds
        .slice()
        .sort((a, b) => (nameById.get(a) ?? '').localeCompare(nameById.get(b) ?? ''))
        .slice(0, 5)
        .map((id) => ({ userId: id, username: nameById.get(id) ?? '' })),
      lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
      lastMessagePreview: r.lastMessagePreview,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * task-046 iter0 (HIGH-2 carry-over): GDM 멤버 list 조회.
   *
   * deep-link / refresh 로 sidebar list 를 거치지 않고 GDM 으로 진입한
   * 클라이언트가 멤버 username/customStatus 를 표시할 수 있도록
   * `GET /me/dms/groups/:gdmId/members` 가 호출하는 backend.
   *
   * **권한**: caller (meId) 가 같은 GDM 의 멤버 (USER override allowMask
   * & READ > 0) 여야만 200. 다음은 모두 404 (member 가 아닌 채널의
   * 존재 자체를 leak 하지 않음):
   *  - 채널 부재 / soft-deleted
   *  - 채널 type 이 DIRECT 가 아님
   *  - channel.name 이 `gdm:` prefix 가 아님 (1:1 DM / 일반 채널)
   *  - meId 가 멤버 아님 (override 없거나 allowMask & READ = 0)
   */
  async getGroupMembers(
    meId: string,
    gdmId: string,
  ): Promise<
    Array<{
      userId: string;
      username: string;
      customStatus: string | null;
    }>
  > {
    // 1) channel 존재 + type=DIRECT + gdm: prefix
    const channel = await this.prisma.channel.findFirst({
      where: { id: gdmId, type: 'DIRECT', deletedAt: null },
      select: { id: true, name: true },
    });
    if (!channel || !channel.name?.startsWith('gdm:')) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'group DM not found');
    }
    // 2) caller membership — USER override 의 allowMask & READ > 0
    const myOverride = await this.prisma.channelPermissionOverride.findFirst({
      where: {
        channelId: gdmId,
        principalType: 'USER',
        principalId: meId,
      },
      select: { allowMask: true },
    });
    if (!myOverride || (myOverride.allowMask & Permission.READ) === 0) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'group DM not found');
    }
    // 3) 모든 USER override → User.username/customStatus join
    const rows = await this.prisma.$queryRaw<
      Array<{ userId: string; username: string; customStatus: string | null }>
    >`
      SELECT
        ovr."principalId" AS "userId",
        u.username        AS username,
        u."customStatus"  AS "customStatus"
        FROM "ChannelPermissionOverride" ovr
        JOIN "User" u ON u.id = ovr."principalId"::uuid
       WHERE ovr."channelId" = ${gdmId}::uuid
         AND ovr."principalType" = 'USER'
         AND (ovr."allowMask" & 1) > 0
       ORDER BY u.username ASC
    `;
    return rows.map((r) => ({
      userId: r.userId,
      username: r.username,
      customStatus: r.customStatus,
    }));
  }

  async list(workspaceId: string | null, meId: string, limit = 50): Promise<DmListItem[]> {
    const capped = Math.max(1, Math.min(100, limit));
    // task-033-B: when workspaceId is null (Global DM), list every
    // DIRECT channel the caller has an ALLOW override on — regardless
    // of workspace scope. When a workspace is specified we keep the
    // original 027-scoped behaviour.
    const rows = await this.prisma.$queryRaw<
      Array<{
        channelId: string;
        otherUserId: string;
        otherUsername: string;
        lastMessageAt: Date | null;
        lastMessagePreview: string | null;
        unreadCount: bigint;
      }>
    >`
      WITH my_dms AS (
        SELECT c.id AS "channelId"
          FROM "Channel" c
          JOIN "ChannelPermissionOverride" mine
            ON mine."channelId" = c.id
           AND mine."principalType" = 'USER'
           AND mine."principalId" = ${meId}::text
           AND (mine."allowMask" & 1) > 0
         WHERE (${workspaceId}::uuid IS NULL OR c."workspaceId" = ${workspaceId}::uuid)
           AND c.type = 'DIRECT'
           AND c."deletedAt" IS NULL
           -- task-045 iter8: 1:1 DM 만 — group DM (gdm: prefix) 은 별도 listGroups() 처리.
           AND c.name NOT LIKE 'gdm:%'
      ),
      peers AS (
        SELECT md."channelId",
               peer."principalId" AS "otherUserId"
          FROM my_dms md
          JOIN "ChannelPermissionOverride" peer
            ON peer."channelId" = md."channelId"
           AND peer."principalType" = 'USER'
           AND peer."principalId" <> ${meId}::text
      ),
      last_msg AS (
        SELECT DISTINCT ON (m."channelId")
               m."channelId",
               m."createdAt",
               LEFT(m."contentPlain", 140) AS preview
          FROM "Message" m
          JOIN my_dms md ON md."channelId" = m."channelId"
         WHERE m."deletedAt" IS NULL
         ORDER BY m."channelId", m."createdAt" DESC
      )
      SELECT
        p."channelId",
        p."otherUserId",
        u.username AS "otherUsername",
        lm."createdAt" AS "lastMessageAt",
        lm.preview AS "lastMessagePreview",
        COALESCE((
          SELECT COUNT(*)::bigint
            FROM "Message" m2
            LEFT JOIN "UserChannelReadState" rs
              ON rs."userId" = ${meId}::uuid
             AND rs."channelId" = m2."channelId"
           WHERE m2."channelId" = p."channelId"
             AND m2."deletedAt" IS NULL
             -- S11 (FR-RT-14): (createdAt, id) 튜플 커서로 통일. read-state
             -- NULL ⇒ 전부 미읽음. senderId 제외 없음(자기 메시지 포함).
             AND (
               rs."lastReadMessageCreatedAt" IS NULL
               OR (m2."createdAt", m2.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
             )
        ), 0) AS "unreadCount"
      FROM peers p
      JOIN "User" u ON u.id = p."otherUserId"::uuid
      LEFT JOIN last_msg lm ON lm."channelId" = p."channelId"
      ORDER BY lm."createdAt" DESC NULLS LAST, u.username ASC
      LIMIT ${capped}
    `;
    return rows.map((r) => ({
      channelId: r.channelId,
      otherUserId: r.otherUserId,
      otherUsername: r.otherUsername,
      lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
      lastMessagePreview: r.lastMessagePreview,
      unreadCount: Number(r.unreadCount),
      // FR-DM-03: 1:1 DM 의 상대방 프로필을 참여자 배열로도 노출(헤더/아바타 스택이
      // 멤버 set 을 일관 렌더). 1:1 은 본인을 제외한 상대 1명이므로 **항상 정확히
      // 1개 요소**다(그룹 listGroups 의 ≤5 슬라이스와 shape 만 동일).
      participants: [{ userId: r.otherUserId, username: r.otherUsername }],
    }));
  }

  async findByUser(
    workspaceId: string | null,
    meId: string,
    otherUserId: string,
  ): Promise<{ channelId: string } | null> {
    const name = this.channelName(meId, otherUserId);
    const ch = await this.prisma.channel.findFirst({
      where: {
        ...(workspaceId === null ? {} : { workspaceId }),
        name,
        type: 'DIRECT',
        deletedAt: null,
      },
      select: { id: true },
    });
    return ch ? { channelId: ch.id } : null;
  }

  /**
   * task-033-B: friend-gated Global DM. Channel.workspaceId is NULL
   * for global DMs (034-A widened the schema + 034 review added the
   * partial UNIQUE on name under that subset). Enforces ACCEPTED
   * friendship between the pair — BLOCKED or missing friendship is
   * rejected.
   */
  async createOrGetGlobal(
    meId: string,
    otherUserId: string,
  ): Promise<{ channelId: string; created: boolean }> {
    // S16 (H-03): 친구 게이트는 assertCanDm 로 추출됨. self·미친구·BLOCKED 를
    // 동일 status(404) + 동일 중립 메시지로 거부(차단 여부 비노출).
    await this.assertCanDm(meId, otherUserId);
    // task-034-A: Channel.workspaceId is nullable now. Global DM is a
    // DIRECT channel with no workspace. Reuse the createOrGet path by
    // passing null workspaceId — the service skips the workspace-
    // member gate when workspaceId is null.
    return this.createOrGetWorkspaceless(meId, otherUserId);
  }

  private async createOrGetWorkspaceless(
    meId: string,
    otherUserId: string,
  ): Promise<{ channelId: string; created: boolean }> {
    const name = this.channelName(meId, otherUserId);
    const existing = await this.prisma.channel.findFirst({
      where: { workspaceId: null, name, type: 'DIRECT', deletedAt: null },
      select: { id: true },
    });
    if (existing) return { channelId: existing.id, created: false };

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const ch = await tx.channel.create({
          data: {
            workspaceId: null,
            name,
            type: 'DIRECT',
            isPrivate: true,
            topic: null,
            position: 0,
            categoryId: null,
          },
        });
        for (const uid of [meId, otherUserId]) {
          await tx.channelPermissionOverride.create({
            data: {
              channelId: ch.id,
              principalType: 'USER',
              principalId: uid,
              allowMask: DM_ALLOW_MASK,
              denyMask: 0,
            },
          });
        }
        // S16 (FR-DM-16): 같은 commit 에 dm.created 기록.
        await this.recordDmCreated(tx as unknown as OutboxTxClient, {
          channelId: ch.id,
          participantIds: [meId, otherUserId],
          isGroup: false,
        });
        return ch;
      });
      return { channelId: created.id, created: true };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        const winner = await this.prisma.channel.findFirst({
          where: { workspaceId: null, name, type: 'DIRECT', deletedAt: null },
          select: { id: true },
        });
        if (winner) return { channelId: winner.id, created: false };
      }
      throw err;
    }
  }
}
