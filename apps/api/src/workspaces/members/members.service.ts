import { Injectable } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import {
  LARGE_WORKSPACE_THRESHOLD,
  MEMBER_DIRECTORY_PAGE_SIZE,
  MEMBER_LIST_PAGE_SIZE,
  ROLE_RANK,
  type HoistGroup,
  type ListMembersResponse,
  type ListMemberDirectoryResponse,
  type MemberDirectoryRow,
  type MemberDirectorySort,
  type MemberStatusGroup,
  type MemberWithPresence,
  type StatusGroup,
  WorkspaceRole as SharedRole,
} from '@qufox/shared-types';
import { pickTopHoistRoleId, sortHoistedRoles, type HoistedRoleInfo } from './member-hoist';
import { PrismaService } from '../../prisma/prisma.module';
import { S3Service } from '../../storage/s3.service';
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
// S64 (FR-RM12): 멤버 역할 변경 감사 기록.
import { AuditService, AuditAction } from '../../common/audit/audit.service';

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

/** FR-P09 (task-068): hoisted 역할 미보유 멤버용 공유 빈 집합(불필요한 Set 할당 회피). */
const EMPTY_ROLE_SET: ReadonlySet<string> = new Set<string>();

interface MemberRow {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: Date;
  // S63 (FR-RM07): 모더레이션 타임아웃 만료 시각(또는 null). FE 배지용.
  mutedUntil: Date | null;
  user: {
    id: string;
    email: string;
    username: string;
    customStatus: string | null;
    // S28 (HIGH-2 + FR-P17): emoji + expiresAt 도 SELECT — emoji 노출 + 만료 마스킹.
    customStatusEmoji: string | null;
    customStatusExpiresAt: Date | null;
    lastSeenAt: Date | null;
    // S74 (FR-PS-06 + S73 carryover): 전역 표시명/아바타 키(표시 우선순위 폴백 기준).
    displayName: string | null;
    avatarKey: string | null;
    // S74 (FR-PS-06): 이 워크스페이스 프로필 오버라이드(LEFT JOIN — 미설정 시 빈 배열).
    workspaceMemberProfiles: { nickname: string | null; avatarKey: string | null }[];
  };
}

/** S74: WorkspaceMemberProfile LEFT JOIN — 이 워크스페이스 행만 1개(또는 0개) 포함시킨다. */
function memberUserSelect(workspaceId: string) {
  return {
    id: true,
    email: true,
    username: true,
    customStatus: true,
    customStatusEmoji: true,
    customStatusExpiresAt: true,
    lastSeenAt: true,
    // S74 (S73 carryover): 전역 표시명/아바타.
    displayName: true,
    avatarKey: true,
    // S74 (FR-PS-06): 현재 워크스페이스의 오버라이드 한 행(@@unique 라 최대 1개).
    workspaceMemberProfiles: {
      where: { workspaceId },
      select: { nickname: true, avatarKey: true },
      take: 1,
    },
  } as const;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    // S74 (FR-PS-06): ws아바타/전역아바타 키 → presigned GET URL 파생.
    private readonly s3: S3Service,
    private readonly outbox: OutboxService,
    private readonly presence: PresenceService,
    // S62 fix-forward (security A-1 = MAJOR-1 / MEDIUM-2): 시스템 역할 enum 변경
    // (MEMBER↔ADMIN 등)은 멤버 유효 권한을 바꾸므로 트랜잭션 직후 채널별 권한 캐시
    // (perms:{channelId}:{userId})를 DEL 해 강등/승격 후 stale 권한 행사를 막는다.
    private readonly memberRoles: MemberRoleService,
    // S64 (FR-RM12): 시스템 역할 enum 변경(MEMBER_ROLE_UPDATE) 감사 기록.
    private readonly audit: AuditService,
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
   * Grouping (FR-P09 · task-068 · S95): 역할기반 hoist. Role.hoistInMemberList=true
   * 역할마다 별도 그룹을 status 버킷 위에 올린다(per-role · 종전 단일 'staff' 그룹 대체).
   * 각 멤버는 보유한 hoisted 역할 중 최상위(position 최대) 1개 그룹에만 들어간다(다중
   * hoisted 역할 dedup). **온라인 멤버만 hoist** 된다 — hoisted 역할 보유여도 offline 이면
   * offline status 그룹으로 강등한다(PRD "그룹 내 온라인 멤버만 기본 표시"). hoisted 역할이
   * 없거나 offline 인 멤버는 masked status(online/idle/dnd/offline)로 버킷팅한다. 모든
   * 그룹 내부는 online-first(STATUS_SORT_WEIGHT) → joinedAt asc 로 안정·페이지 안전 정렬.
   *
   * hoist 쿼리 경로(N+1 회피): hoisted Role 1회 배치 조회 + 그 역할들의 MemberRole
   * assignment 1회 배치 조회(roleId IN)만 추가한다 — 멤버당 쿼리가 아니다(FR-P12).
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
        // S74 (FR-PS-06 + S73 carryover): displayName/avatarKey + ws프로필 오버라이드 LEFT JOIN.
        user: { select: memberUserSelect(workspaceId) },
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

    // FR-P09 (task-068 · S95): 역할기반 hoist 입력 2개를 배치 조회한다(N+1 없음).
    //   1. hoistInMemberList=true 역할(position DESC) — 그룹 정의 + 표시 순서.
    //   2. 그 역할들의 MemberRole assignment(roleId IN) — userId → 보유 hoisted 역할 집합.
    // hoisted 역할이 없으면 assignment 조회를 건너뛴다(추가 쿼리 0).
    const hoistedRoleRows = await this.prisma.role.findMany({
      where: { workspaceId, hoistInMemberList: true },
      select: { id: true, name: true, position: true, colorHex: true },
      orderBy: [{ position: 'desc' }, { id: 'asc' }],
    });
    const sortedHoistedRoles: HoistedRoleInfo[] = sortHoistedRoles(
      hoistedRoleRows.map((r) => ({
        roleId: r.id,
        name: r.name,
        position: r.position,
        colorHex: r.colorHex,
      })),
    );
    const memberHoistedRoleIds = new Map<string, Set<string>>();
    if (sortedHoistedRoles.length > 0) {
      // FR-P09 fix-forward (reviewer MED + perf serious): LARGE 경로(restrictToUserIds
      // 설정 시)에는 렌더 대상 online/dnd 집합으로 assignment 조회를 바운드한다. 종전엔
      // hoistInMemberList=true 역할의 워크스페이스 전체 assignment 를 가져왔는데, hoist
      // 계산은 로드된 rows 의 userId 만 인덱싱하므로 online 집합 밖 행은 어차피 미사용이라
      // 결과 불변(출력 동일)이면서 행 수만 줄인다. restrictToUserIds 없으면(SMALL) 종전대로
      // 워크스페이스 전체를 받는다(@@index([workspaceId, roleId]) 커버).
      const assignments = await this.prisma.memberRole.findMany({
        where: {
          workspaceId,
          roleId: { in: sortedHoistedRoles.map((r) => r.roleId) },
          ...(restrictToUserIds ? { userId: { in: restrictToUserIds } } : {}),
        },
        select: { userId: true, roleId: true },
      });
      for (const a of assignments) {
        let set = memberHoistedRoleIds.get(a.userId);
        if (!set) {
          set = new Set<string>();
          memberHoistedRoleIds.set(a.userId, set);
        }
        set.add(a.roleId);
      }
    }

    // Build COMPLETE groups over the whole set first (authoritative grouping).
    // FR-P09: per-role hoist 버킷(roleId → members). 표시 순서는 sortedHoistedRoles.
    const hoistBuckets = new Map<string, MemberWithPresence[]>();
    for (const r of sortedHoistedRoles) hoistBuckets.set(r.roleId, []);
    const statusBuckets: Record<MemberStatusGroup, MemberWithPresence[]> = {
      online: [],
      idle: [],
      dnd: [],
      offline: [],
    };

    // S74: presignGet 은 서명만(네트워크 없음)이라 멤버 전체 DTO 를 Promise.all 로 병렬
    // 변환해도 N+1 네트워크 비용이 없다(단일 SELECT 는 위에서 이미 끝났다).
    const dtos = await Promise.all(
      rows.map(async (row) => {
        const presence = byUser.get(row.userId);
        const status = toStatusGroup(presence?.status);
        const isSelf = row.userId === viewerUserId;
        // S27 fix-forward(security BLOCKER · lastSeenAt leak): suppress lastSeenAt
        // for an invisible-masked row (real === invisible, not self). Such a row
        // may carry a stale DND-era lastSeenAt that would leak when they went dark.
        const invisibleMasked = presence?.real === 'invisible' && !isSelf;
        return { row, status, dto: await this.toDto(row, status, invisibleMasked, now) };
      }),
    );
    for (const { row, status, dto } of dtos) {
      // FR-P09: 온라인(≠offline)이고 보유한 hoisted 역할이 있으면 그 최상위 1개 그룹으로.
      // offline 이면 hoisted 역할 보유여도 status 그룹으로 강등한다(PRD — hoist 는 online 만).
      if (status !== 'offline') {
        const topRoleId = pickTopHoistRoleId(
          sortedHoistedRoles,
          memberHoistedRoleIds.get(row.userId) ?? EMPTY_ROLE_SET,
        );
        if (topRoleId !== null) {
          hoistBuckets.get(topRoleId)!.push(dto);
          continue;
        }
      }
      if (status === 'offline' && !includeOffline) continue; // FR-P11
      statusBuckets[status].push(dto);
    }

    for (const bucket of hoistBuckets.values()) sortGroup(bucket);
    for (const key of STATUS_GROUP_ORDER) sortGroup(statusBuckets[key]);

    // S27 fix-forward(FR-P12): canonical flat order = hoist then status groups in
    // display order. Slice a 50-row window by cursor position over THIS order so
    // the groups within a page are authoritative (computed over all members) and
    // pages never duplicate or drop a member. nextCursor = userId of the last row
    // in the window (keyset over the deterministic sort).
    //
    // FR-P09 (task-068 · S95): hoist 영역은 per-role 이라 entry 에 group kind 를 구분해
    // 싣는다(hoist=roleId, status=status key). hoist 그룹은 sortedHoistedRoles 의 표시
    // 순서(position DESC)로 flatten 한다.
    type FlatEntry =
      | { kind: 'hoist'; roleId: string; dto: MemberWithPresence }
      | { kind: 'status'; status: MemberStatusGroup; dto: MemberWithPresence };
    const flat: FlatEntry[] = [];
    for (const role of sortedHoistedRoles) {
      for (const dto of hoistBuckets.get(role.roleId) ?? []) {
        flat.push({ kind: 'hoist', roleId: role.roleId, dto });
      }
    }
    for (const key of STATUS_GROUP_ORDER) {
      if (key === 'offline' && !includeOffline) continue; // FR-P11
      for (const dto of statusBuckets[key]) flat.push({ kind: 'status', status: key, dto });
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
    // FR-P09: hoist 는 roleId 별 버킷으로, status 는 status key 별 버킷으로 재조립한다.
    const pageHoistByRole = new Map<string, MemberWithPresence[]>();
    const pageBuckets: Record<MemberStatusGroup, MemberWithPresence[]> = {
      online: [],
      idle: [],
      dnd: [],
      offline: [],
    };
    for (const entry of window) {
      if (entry.kind === 'hoist') {
        let bucket = pageHoistByRole.get(entry.roleId);
        if (!bucket) {
          bucket = [];
          pageHoistByRole.set(entry.roleId, bucket);
        }
        bucket.push(entry.dto);
      } else {
        pageBuckets[entry.status].push(entry.dto);
      }
    }

    // FR-P09: hoist 그룹 = 역할별 1개({key: roleId, label: 역할명, color, members}),
    // position DESC(sortedHoistedRoles 순서). 이 페이지에 멤버가 없는 hoisted 역할은 생략.
    const hoist: HoistGroup[] = [];
    for (const role of sortedHoistedRoles) {
      const members = pageHoistByRole.get(role.roleId);
      if (!members || members.length === 0) continue;
      hoist.push({ key: role.roleId, label: role.name, color: role.colorHex, members });
    }

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
   * S69 (D13 / FR-W10): 멤버 디렉터리. listGrouped(프레즌스 그룹핑·@멘션 전체로드)와
   * 분리된 **검색/필터/정렬 전용** 경로다(Fork D — FE 가 전체로드 대신 이 API 를 직접
   * 페이지네이션한다). 열람은 모든 워크스페이스 멤버에게 허용한다(Fork C — 컨트롤러가
   * WorkspaceMemberGuard 만 적용·역할 무관).
   *
   *   - q:      username/email **prefix**(대소문자 무시) DB 쿼리 레벨 필터.
   *   - role:   역할 정확 일치(@@index([workspaceId, role]) 활용).
   *   - sortBy: 가입일 정렬(joined_desc 기본 · @@index([workspaceId, joinedAt, userId])).
   *   - cursor: (joinedAt, userId) keyset — 정렬 방향과 일관된 부등호로 다음 페이지.
   *
   * 프레즌스는 결과 50건에만 bulkFor(단일 fan-out · INVISIBLE→offline 마스킹)한다 —
   * 전체 멤버를 로드하지 않으므로 대규모 워크스페이스에서도 bounded 다. 초대자(invitedBy)는
   * 같은 쿼리에서 include 로 함께 읽어 N+1 을 만들지 않는다.
   */
  async listDirectory(args: {
    workspaceId: string;
    viewerUserId: string;
    // S69 fix-forward (security HIGH/BLOCKER): 뷰어의 시스템 역할. ADMIN+ 만 email
    // 검색/노출 + 초대자(invitedBy)를 받는다. 비관리자(MEMBER/GUEST)는 q 가 username 만
    // 매칭(email 매칭 제외 → prefix enumeration 차단)하고 응답에서 email/invitedBy 가 null.
    actorRole: SharedRole;
    q?: string;
    role?: SharedRole;
    sortBy?: MemberDirectorySort;
    cursor?: string;
  }): Promise<ListMemberDirectoryResponse> {
    const { workspaceId, viewerUserId, actorRole } = args;
    const now = new Date();
    const sortBy: MemberDirectorySort = args.sortBy ?? 'joined_desc';
    const ascending = sortBy === 'joined_asc';
    // S69 fix-forward (security): ADMIN+ 뷰어만 email/invitedBy PII 를 본다.
    const isAdminViewer = ROLE_RANK[actorRole] >= ROLE_RANK.ADMIN;

    const where: Prisma.WorkspaceMemberWhereInput = { workspaceId };
    if (args.role) {
      where.role = WorkspaceRole[args.role];
    }
    const q = args.q?.trim();
    if (q) {
      // prefix 검색(startsWith·대소문자 무시). ADMIN+ 는 username 또는 email 매칭,
      // 비관리자는 **username 만** 매칭한다(email prefix enumeration 차단 — security HIGH).
      where.user = isAdminViewer
        ? {
            OR: [
              { username: { startsWith: q, mode: 'insensitive' } },
              { email: { startsWith: q, mode: 'insensitive' } },
            ],
          }
        : { username: { startsWith: q, mode: 'insensitive' } };
    }
    // keyset cursor: 정렬 방향에 맞춰 (joinedAt, userId) 튜플 부등호로 다음 페이지를 연다.
    const decoded = decodeDirectoryCursor(args.cursor);
    if (decoded) {
      const cmp = ascending ? 'gt' : 'lt';
      where.OR = [
        { joinedAt: { [cmp]: decoded.joinedAt } },
        { joinedAt: decoded.joinedAt, userId: { [cmp]: decoded.userId } },
      ];
    }

    const rows = await this.prisma.workspaceMember.findMany({
      where,
      include: {
        // S74 (FR-PS-06 + S73 carryover): displayName/avatarKey + ws프로필 오버라이드 LEFT JOIN.
        user: { select: memberUserSelect(workspaceId) },
        // S69 (FR-W10): 초대자 표시 정보(프로필 패널). 초대자 미설정/계정삭제(SetNull) 시 null.
        invitedBy: { select: { id: true, username: true } },
      },
      orderBy: [{ joinedAt: ascending ? 'asc' : 'desc' }, { userId: ascending ? 'asc' : 'desc' }],
      take: MEMBER_DIRECTORY_PAGE_SIZE + 1,
    });

    const hasMore = rows.length > MEMBER_DIRECTORY_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, MEMBER_DIRECTORY_PAGE_SIZE) : rows;

    const presences = await this.presence.bulkFor(
      viewerUserId,
      page.map((r) => r.userId),
    );
    const byUser = new Map(presences.map((p) => [p.userId, p]));

    const members: MemberDirectoryRow[] = await Promise.all(
      page.map(async (row) => {
        const presence = byUser.get(row.userId);
        const status = toStatusGroup(presence?.status);
        const isSelf = row.userId === viewerUserId;
        const invisibleMasked = presence?.real === 'invisible' && !isSelf;
        const base = await this.toDto(
          {
            workspaceId: row.workspaceId,
            userId: row.userId,
            role: row.role,
            joinedAt: row.joinedAt,
            mutedUntil: row.mutedUntil,
            user: row.user,
          },
          status,
          invisibleMasked,
          now,
        );
        // S69 fix-forward (security HIGH/BLOCKER): 비관리자 뷰어에겐 PII(email)·초대자
        // (invitedBy/invitedById)를 노출하지 않는다(null). ADMIN+ 만 기존대로 받는다.
        return {
          ...base,
          user: { ...base.user, email: isAdminViewer ? base.user.email : null },
          invitedById: isAdminViewer ? (row.invitedById ?? null) : null,
          invitedBy:
            isAdminViewer && row.invitedBy
              ? { id: row.invitedBy.id, username: row.invitedBy.username }
              : null,
        };
      }),
    );

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeDirectoryCursor({ joinedAt: last.joinedAt, userId: last.userId })
        : null;

    return { members, nextCursor };
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
  private async toDto(
    row: MemberRow,
    status: MemberStatusGroup,
    invisibleMasked: boolean,
    now: Date,
  ): Promise<MemberWithPresence> {
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
    // S74 (FR-PS-06 + S73 carryover): ws 오버라이드 + 전역 키 → 표시 필드.
    // presignGet 은 서명만(네트워크 없음). 우선순위 해석은 FE/shared-types 헬퍼가 한다
    // (서버는 양쪽 값을 모두 내려보내고 키→URL 만 파생). 미설정 키는 URL 도 null.
    const wsProfile = row.user.workspaceMemberProfiles[0];
    const wsAvatarKey = wsProfile?.avatarKey ?? null;
    const [avatarUrl, wsAvatarUrl] = await Promise.all([
      row.user.avatarKey ? this.s3.presignGet(row.user.avatarKey) : Promise.resolve(null),
      wsAvatarKey ? this.s3.presignGet(wsAvatarKey) : Promise.resolve(null),
    ]);
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
        // S74 (FR-PS-06 + S73 carryover): 표시 우선순위 전파 필드.
        displayName: row.user.displayName,
        avatarUrl,
        wsNickname: wsProfile?.nickname ?? null,
        wsAvatarUrl,
      },
      status,
      lastSeenAt: exposeLastSeen ? desensitiseToDay(row.user.lastSeenAt) : null,
      // S63 (FR-RM07): 활성 타임아웃(mutedUntil>now)만 노출한다. 만료분은 lazy 하게
      // null 로 마스킹해 FE 가 만료 배지를 잘못 그리지 않게 한다.
      mutedUntil:
        row.mutedUntil && row.mutedUntil.getTime() > now.getTime()
          ? row.mutedUntil.toISOString()
          : null,
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
      // S64 (FR-RM12): 멤버 시스템 역할 변경 감사(같은 tx — 원자성).
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: AuditAction.MEMBER_ROLE_UPDATE,
          targetId: targetUserId,
          details: { from: target.role, to: row.role },
        },
        tx,
      );
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
 * S69 (FR-W10): 디렉터리 keyset cursor = base64url(JSON{joinedAt ISO, userId}).
 * (joinedAt, userId) 튜플은 정렬(joinedAt then userId)의 유일 keyset anchor 다.
 * 잘못된 cursor 는 decode 가 null 을 돌려줘 첫 페이지로 폴백한다(500 방지). userId 는
 * UUID 검증 후에만 사용한다(member-list cursor 와 동일한 방어).
 */
function encodeDirectoryCursor(c: { joinedAt: Date; userId: string }): string {
  return Buffer.from(
    JSON.stringify({ joinedAt: c.joinedAt.toISOString(), userId: c.userId }),
    'utf8',
  ).toString('base64url');
}

function decodeDirectoryCursor(
  cursor: string | undefined,
): { joinedAt: Date; userId: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const joinedAtRaw = obj.joinedAt;
    const userId = obj.userId;
    if (typeof joinedAtRaw !== 'string' || typeof userId !== 'string') return null;
    if (!UUID_RE.test(userId)) return null;
    const joinedAt = new Date(joinedAtRaw);
    if (Number.isNaN(joinedAt.getTime())) return null;
    return { joinedAt, userId };
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
