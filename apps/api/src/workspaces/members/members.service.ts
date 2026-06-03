import { Injectable } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import {
  HOISTED_ROLES,
  LARGE_WORKSPACE_THRESHOLD,
  MEMBER_LIST_PAGE_SIZE,
  ROLE_RANK,
  type HoistGroup,
  type ListMembersResponse,
  type MemberStatusGroup,
  type MemberWithPresence,
  type StatusGroup,
  WorkspaceRole as SharedRole,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PresenceService } from '../../realtime/presence/presence.service';
import { maskExpiredStatus } from '../../me/custom-status.service';
import { MEMBER_LEFT, MEMBER_REMOVED, ROLE_CHANGED } from '../events/workspace-events';
// S61 fix-forward (security A-2): 역할 변경 시 시스템 MemberRole 동기.
import { syncMemberSystemRole } from '../roles/system-role-seed';
// S62 fix-forward (security A-1): 시스템 역할 enum 변경 직후 권한 캐시 무효화.
import { MemberRoleService } from '../roles/member-role.service';

/** S27 (FR-P08): status group display order. */
const STATUS_GROUP_ORDER: MemberStatusGroup[] = ['online', 'idle', 'dnd', 'offline'];
const STATUS_GROUP_LABEL: Record<MemberStatusGroup, string> = {
  online: '온라인',
  idle: '자리 비움',
  dnd: '다른 용무 중',
  offline: '오프라인',
};

/** S27 (FR-P08): online-first sort weight INSIDE a group (online > idle > dnd > offline). */
const STATUS_SORT_WEIGHT: Record<MemberStatusGroup, number> = {
  online: 0,
  idle: 1,
  dnd: 2,
  offline: 3,
};

interface MemberRow {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: Date;
  user: {
    id: string;
    email: string;
    username: string;
    customStatus: string | null;
    // S28 (HIGH-2 + FR-P17): emoji + expiresAt 도 SELECT — emoji 노출 + 만료 마스킹.
    customStatusEmoji: string | null;
    customStatusExpiresAt: Date | null;
    lastSeenAt: Date | null;
  };
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly presence: PresenceService,
    // S62 fix-forward (security A-1 = MAJOR-1 / MEDIUM-2): 시스템 역할 enum 변경
    // (MEMBER↔ADMIN 등)은 멤버 유효 권한을 바꾸므로 트랜잭션 직후 채널별 권한 캐시
    // (perms:{channelId}:{userId})를 DEL 해 강등/승격 후 stale 권한 행사를 막는다.
    private readonly memberRoles: MemberRoleService,
  ) {}

  /**
   * S27 (FR-P08/P09/P11/P12): grouped, presence-aware, paginated member list.
   *
   * S27 fix-forward(correctness BLOCKER · authoritative grouping): grouping is
   * computed over the **whole** member set, not a join-ordered 50-row slice. The
   * previous design bucketed only the current page, so a workspace with > 50
   * members produced TRUNCATED groups (the online group could be missing members
   * who happened to sort past the first 50 by join order). Now:
   *
   *   - SMALL (< LARGE_WORKSPACE_THRESHOLD): load ALL members, one bulkFor for
   *     all, build COMPLETE groups, then slice the canonical sorted flat order
   *     by cursor into a 50-row page (FR-P12). Member count is bounded so a full
   *     load is cheap and the groups are authoritative.
   *   - LARGE (>= threshold): load ONLY the online/dnd members (presence.onlineIn
   *     ∪ dndIn gives the bounded online userId set), so the response stays
   *     bounded even at 10k+ members. OFFLINE is dropped by default (FR-P11) and
   *     the online groups are complete over the online set.
   *
   * Query path stays N+1-free: ONE count, ONE Prisma SELECT (whole set or the
   * online subset), ONE PresenceService.bulkFor for that set — a single fan-out,
   * never per-member (FR-P12). bulkFor masks INVISIBLE → OFFLINE for every viewer
   * except themselves (FR-P08 single masking point) and returns each row's real
   * status so the lastSeenAt leak guard can act on it.
   *
   * Grouping: hoisted roles (OWNER/ADMIN baseline, FR-P09) lift into a single
   * "staff" group above the status buckets; everyone else buckets by masked
   * status (online/idle/dnd/offline). Within every group, online-first
   * (STATUS_SORT_WEIGHT) then joinedAt asc for a stable, paginate-safe order.
   */
  async listGrouped(args: {
    workspaceId: string;
    viewerUserId: string;
    cursor?: string;
    /** FR-P11 override. undefined → default (large workspaces drop OFFLINE). */
    includeOffline?: boolean;
  }): Promise<ListMembersResponse> {
    const { workspaceId, viewerUserId, cursor } = args;
    // S28 (HIGH-2 + FR-P17): 만료 마스킹 기준 시각. 한 요청 안에서 일관되게 쓴다.
    const now = new Date();

    // S27 fix-forward(perf): count once. The keyset slicing below operates on the
    // already-built sorted order, so we never re-count per page.
    const total = await this.prisma.workspaceMember.count({ where: { workspaceId } });
    const isLarge = total >= LARGE_WORKSPACE_THRESHOLD;
    // FR-P11: large workspaces omit OFFLINE unless the client explicitly opts in.
    const includeOffline = args.includeOffline ?? !isLarge;

    // S27 fix-forward(correctness BLOCKER): for a LARGE workspace, restrict the
    // Prisma load to the bounded online/dnd member set so we never materialise
    // 10k rows. onlineIn already lazily GC's dead sessions; dnd users are also
    // "online" for the roster. When the caller explicitly opts into OFFLINE on a
    // large workspace we fall back to the full load (bounded only by their opt-in).
    const restrictToUserIds =
      isLarge && !includeOffline
        ? [
            ...new Set([
              ...(await this.presence.onlineIn(workspaceId)),
              ...(await this.presence.dndIn(workspaceId)),
            ]),
          ]
        : undefined;

    const rows = (await this.prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        ...(restrictToUserIds ? { userId: { in: restrictToUserIds } } : {}),
      },
      include: {
        // task-046 iter0 (MED-5 carry-over): customStatus 를 첫 페인트부터 노출.
        // S27 (FR-P10): lastSeenAt 도 함께 SELECT — offline 그룹 표기용.
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            customStatus: true,
            // S28 (HIGH-2 + FR-P17): emoji + expiresAt — 만료 마스킹 + emoji 노출.
            customStatusEmoji: true,
            customStatusExpiresAt: true,
            lastSeenAt: true,
          },
        },
      },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    })) as MemberRow[];

    // FR-P12: ONE bulkFor for the WHOLE loaded set (single fan-out, masked for
    // viewer). Returns real status too so the lastSeenAt leak guard can act.
    const presences = await this.presence.bulkFor(
      viewerUserId,
      rows.map((r) => r.userId),
    );
    const byUser = new Map(presences.map((p) => [p.userId, p]));

    // Build COMPLETE groups over the whole set first (authoritative grouping).
    const hoistMembers: MemberWithPresence[] = [];
    const statusBuckets: Record<MemberStatusGroup, MemberWithPresence[]> = {
      online: [],
      idle: [],
      dnd: [],
      offline: [],
    };

    for (const row of rows) {
      const presence = byUser.get(row.userId);
      const status = toStatusGroup(presence?.status);
      const isSelf = row.userId === viewerUserId;
      // S27 fix-forward(security BLOCKER · lastSeenAt leak): suppress lastSeenAt
      // for an invisible-masked row (real === invisible, not self). Such a row
      // may carry a stale DND-era lastSeenAt that would leak when they went dark.
      const invisibleMasked = presence?.real === 'invisible' && !isSelf;
      const dto = this.toDto(row, status, invisibleMasked, now);

      if (HOISTED_ROLES.has(row.role)) {
        hoistMembers.push(dto);
        continue;
      }
      if (status === 'offline' && !includeOffline) continue; // FR-P11
      statusBuckets[status].push(dto);
    }

    sortGroup(hoistMembers);
    for (const key of STATUS_GROUP_ORDER) sortGroup(statusBuckets[key]);

    // S27 fix-forward(FR-P12): canonical flat order = hoist then status groups in
    // display order. Slice a 50-row window by cursor position over THIS order so
    // the groups within a page are authoritative (computed over all members) and
    // pages never duplicate or drop a member. nextCursor = userId of the last row
    // in the window (keyset over the deterministic sort).
    const flat: Array<{ groupKey: 'staff' | MemberStatusGroup; dto: MemberWithPresence }> = [];
    for (const dto of hoistMembers) flat.push({ groupKey: 'staff', dto });
    for (const key of STATUS_GROUP_ORDER) {
      if (key === 'offline' && !includeOffline) continue; // FR-P11
      for (const dto of statusBuckets[key]) flat.push({ groupKey: key, dto });
    }

    const decoded = decodeCursor(cursor);
    // Keyset over the deterministic sort: resume strictly AFTER the cursor's
    // userId. A cursor whose userId is no longer present (member left / its group
    // shifted out) → findIndex -1 → start at 0 (first page) rather than skipping
    // the whole list. No cursor → first page.
    const cursorIdx = decoded ? flat.findIndex((e) => e.dto.userId === decoded.userId) : -1;
    const start = cursorIdx >= 0 ? cursorIdx + 1 : 0;
    const windowEnd = Math.min(start + MEMBER_LIST_PAGE_SIZE, flat.length);
    const window = flat.slice(start, windowEnd);
    const hasMore = windowEnd < flat.length;
    const nextCursor =
      hasMore && window.length > 0
        ? encodeCursor({ userId: window[window.length - 1].dto.userId })
        : null;

    // Re-assemble the page slice into groups (preserving display order).
    const pageHoist: MemberWithPresence[] = [];
    const pageBuckets: Record<MemberStatusGroup, MemberWithPresence[]> = {
      online: [],
      idle: [],
      dnd: [],
      offline: [],
    };
    for (const { groupKey, dto } of window) {
      if (groupKey === 'staff') pageHoist.push(dto);
      else pageBuckets[groupKey].push(dto);
    }

    const hoist: HoistGroup[] =
      pageHoist.length > 0 ? [{ key: 'staff', label: '운영진', members: pageHoist }] : [];

    const groups: StatusGroup[] = [];
    for (const key of STATUS_GROUP_ORDER) {
      if (key === 'offline' && !includeOffline) continue; // FR-P11
      const members = pageBuckets[key];
      if (members.length === 0) continue;
      groups.push({ key, label: STATUS_GROUP_LABEL[key], members });
    }

    return { hoist, groups, nextCursor, includeOffline };
  }

  /**
   * S27 (FR-P10 leak): map a member row + masked status into the wire DTO.
   * lastSeenAt is non-null ONLY for a genuinely-offline row (status === offline)
   * that is NOT invisible-masked (`invisibleMasked === false`).
   *
   * S27 fix-forward(security BLOCKER): the previous version trusted "the column
   * is only written on OFFLINE/DND, never INVISIBLE" — but a DND→INVISIBLE user
   * stamps lastSeenAt while DND and then masks to offline, so the stale DND-era
   * value would leak when they went dark. `invisibleMasked` is derived from the
   * UNMASKED real status (bulkFor), so any invisible-masked row now drops
   * lastSeenAt entirely. self always sees their own real value.
   *
   * S27 fix-forward(security · FR-P10): the surfaced lastSeenAt is desensitised
   * to **day granularity** (UTC midnight) so the raw millisecond activity time
   * can't be used to fingerprint an activity pattern. UI renders 오늘/어제/N일 전.
   */
  private toDto(
    row: MemberRow,
    status: MemberStatusGroup,
    invisibleMasked: boolean,
    now: Date,
  ): MemberWithPresence {
    const exposeLastSeen = status === 'offline' && !invisibleMasked;
    // S28 (HIGH-2 + FR-P17): 만료된 customStatus(+emoji)는 타인에게 노출되지 않도록
    // expiresAt<=now 면 text/emoji 를 null 로 가린다(getEffective 와 동일 판정 —
    // 공유 helper maskExpiredStatus). 마스킹 후에도 expiresAt 자체는 노출하지 않는다
    // (만료분이라 의미 없음). 비만료분만 expiresAt 을 함께 내려보내 클라가 카운트다운
    // 표시에 쓸 수 있게 한다.
    const masked = maskExpiredStatus({
      text: row.user.customStatus ?? null,
      emoji: row.user.customStatusEmoji ?? null,
      expiresAt: row.user.customStatusExpiresAt ?? null,
      now,
    });
    const stillSet = masked.text !== null || masked.emoji !== null;
    return {
      workspaceId: row.workspaceId,
      userId: row.userId,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
      user: {
        id: row.user.id,
        username: row.user.username,
        email: row.user.email,
        customStatus: masked.text,
        customStatusEmoji: masked.emoji,
        customStatusExpiresAt:
          stillSet && row.user.customStatusExpiresAt
            ? row.user.customStatusExpiresAt.toISOString()
            : null,
      },
      status,
      lastSeenAt: exposeLastSeen ? desensitiseToDay(row.user.lastSeenAt) : null,
    };
  }

  async updateRole(
    workspaceId: string,
    actorId: string,
    actorRole: SharedRole,
    targetUserId: string,
    // S61: 시스템 역할 5단계 확장 — OWNER 는 transfer-ownership 전용이므로
    // 직접 배정 가능한 역할은 ADMIN/MODERATOR/MEMBER/GUEST 4종이다.
    nextRole: 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST',
  ) {
    if (actorId === targetUserId) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'you cannot change your own role',
      );
    }
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
    if (!target) {
      throw new DomainError(ErrorCode.WORKSPACE_TARGET_NOT_MEMBER, 'target user is not a member');
    }
    if (target.role === WorkspaceRole.OWNER) {
      throw new DomainError(
        ErrorCode.WORKSPACE_CANNOT_DEMOTE_OWNER,
        'owner must use transfer-ownership',
      );
    }
    if (ROLE_RANK[actorRole] <= ROLE_RANK[target.role as SharedRole] && actorRole !== 'OWNER') {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'cannot modify a member of equal or higher rank',
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        // S61: nextRole 은 WorkspaceRole enum 의 부분집합(OWNER 제외)이라 그대로 매핑.
        data: { role: WorkspaceRole[nextRole] },
      });
      // S61 fix-forward (security A-2 · MemberRole desync): role enum 변경과 동일
      // 트랜잭션에서 시스템 MemberRole 을 교체한다. 이게 없으면 ADMIN 승격된 멤버가
      // MemberRole 부재로 역할 관리를 전혀 못 한다(actorTop=0·actorMax=0n).
      await syncMemberSystemRole(tx, workspaceId, targetUserId, nextRole);
      await this.outbox.record(tx, {
        aggregateType: 'member',
        aggregateId: targetUserId,
        eventType: ROLE_CHANGED,
        payload: {
          workspaceId,
          userId: targetUserId,
          actorId,
          from: target.role,
          to: row.role,
        },
      });
      return row;
    });
    // S62 fix-forward (security A-1 = MAJOR-1 / MEDIUM-2): 강등/승격으로 멤버의 유효
    // 채널 권한이 바뀌었으므로, 트랜잭션 커밋 직후 그 멤버의 채널별 권한 캐시를 DEL
    // 한다. 이게 없으면 최대 TTL(5초)동안 stale 권한이 남아 강등 후 행동을 막지
    // 못한다(보안 노출 창). best-effort.
    await this.memberRoles.invalidateMemberPermsCache(workspaceId, targetUserId);
    return updated;
  }

  async remove(workspaceId: string, actorId: string, actorRole: SharedRole, targetUserId: string) {
    if (actorId === targetUserId) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'use /members/me/leave to leave a workspace',
      );
    }
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
    if (!target) {
      throw new DomainError(ErrorCode.WORKSPACE_TARGET_NOT_MEMBER, 'target user is not a member');
    }
    if (target.role === WorkspaceRole.OWNER) {
      throw new DomainError(
        ErrorCode.WORKSPACE_CANNOT_REMOVE_OWNER,
        'owner cannot be removed — transfer ownership first',
      );
    }
    if (ROLE_RANK[actorRole] <= ROLE_RANK[target.role as SharedRole] && actorRole !== 'OWNER') {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'cannot remove a member of equal or higher rank',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      await this.outbox.record(tx, {
        aggregateType: 'member',
        aggregateId: targetUserId,
        eventType: MEMBER_REMOVED,
        payload: { workspaceId, userId: targetUserId, actorId },
      });
    });
  }

  async leave(workspaceId: string, userId: string, role: SharedRole) {
    if (role === 'OWNER') {
      throw new DomainError(
        ErrorCode.WORKSPACE_OWNER_MUST_TRANSFER,
        'owner must transfer ownership before leaving',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId } },
      });
      await this.outbox.record(tx, {
        aggregateType: 'member',
        aggregateId: userId,
        eventType: MEMBER_LEFT,
        payload: { workspaceId, userId, actorId: userId },
      });
    });
  }
}

// ── S27 (FR-P08/P12) helpers ───────────────────────────────────────────────

/**
 * S27 (FR-P08): collapse the five observable PresenceStatus values into the
 * four member-list groups. `invisible` should already be masked → `offline`
 * by bulkFor for any non-self viewer, but we map it defensively here too so a
 * self row never lands in its own "invisible" group (none exists). undefined
 * (user not in the presence payload) → offline.
 */
function toStatusGroup(status: string | undefined): MemberStatusGroup {
  switch (status) {
    case 'online':
      return 'online';
    case 'idle':
      return 'idle';
    case 'dnd':
      return 'dnd';
    default:
      // 'offline', 'invisible' (masked or self), or missing → offline bucket.
      return 'offline';
  }
}

/**
 * S27 (FR-P08/P09): online-first within a group, then joinedAt asc, then
 * userId asc as a deterministic tiebreaker (stable across pages).
 */
function sortGroup(members: MemberWithPresence[]): void {
  members.sort((a, b) => {
    const w = STATUS_SORT_WEIGHT[a.status] - STATUS_SORT_WEIGHT[b.status];
    if (w !== 0) return w;
    if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}

/**
 * S27 (FR-P12): opaque cursor = base64url(`u|<userId>`). The cursor marks the
 * last row of the previous page in the canonical sorted flat order; the userId
 * is the unique keyset anchor. A malformed cursor decodes to null → treated as
 * the first page (no 500).
 *
 * S27 fix-forward(security): decodeCursor validates the embedded userId is a
 * UUID before it is used. A non-UUID anchor can't be a real member id, so it
 * decodes to null (first page) rather than reaching any query / findIndex with
 * attacker-controlled garbage. The controller additionally caps cursor length.
 */
function encodeCursor(c: { userId: string }): string {
  return Buffer.from(`u|${c.userId}`, 'utf8').toString('base64url');
}

/** RFC-4122 UUID shape (any version). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string | undefined): { userId: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep === -1) return null;
    const userId = raw.slice(sep + 1);
    if (!UUID_RE.test(userId)) return null;
    return { userId };
  } catch {
    return null;
  }
}

/**
 * S27 fix-forward(security · FR-P10): desensitise a lastSeenAt timestamp to UTC
 * day granularity (midnight of that day) so the surfaced value carries no
 * sub-day activity-pattern signal. null in → null out. The UI maps the day to
 * 오늘/어제/N일 전.
 */
function desensitiseToDay(value: Date | null): string | null {
  if (value === null) return null;
  const day = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0),
  );
  return day.toISOString();
}
