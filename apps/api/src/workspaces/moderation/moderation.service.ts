import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  fromStoragePermissions,
  hasRaw,
  KICK_UNDO_TTL_SECONDS,
  PERMISSIONS,
  ROLE_RANK,
  SYSTEM_ROLE_POSITION,
  type BulkMemberAction,
  type BulkMemberActionResponse,
  type BulkMemberSkipReason,
  type KickMemberResponse,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { REDIS } from '../../redis/redis.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import { AuditService, AuditAction } from '../../common/audit/audit.service';
import { MemberRoleService } from '../roles/member-role.service';
import { syncMemberSystemRole, syncMembersSystemRole } from '../roles/system-role-seed';
import { MEMBER_BANNED, MEMBER_KICKED, ROLE_CHANGED } from '../events/workspace-events';
import type { BannedMember, ListBansResponse, TimeoutMemberResponse } from '@qufox/shared-types';

/**
 * S63 (D12 / FR-RM05·06·07): 모더레이션(Kick / Ban / Timeout) 도메인 서비스.
 *
 * Fork D: members.service.remove(소유권/역할 enum 회귀 방지)와 분리한 신규 서비스다.
 * 권한 게이트는 카탈로그 모더레이션 비트(KICK_MEMBERS/BAN_MEMBERS/TIMEOUT_MEMBERS)를
 * actor 의 보유 Role permissions OR 로 직접 검사한다(S62 채널 집행 enum 과 별개의
 * 워크스페이스 레벨 권한). position 계층 방어(S61)와 자기 자신 대상 방지를 공유한다.
 *
 * undoToken/세션 무효화는 prod 보안 요구다 — kick/ban 모두 outbox 이벤트가
 * kickUserEverywhere 를 트리거해 멀티노드 소켓을 즉시 끊는다(Redis adapter 도달).
 */
@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    // 강제 퇴장/차단/타임아웃 후 대상 멤버의 채널 권한 캐시 무효화(stale 권한 차단).
    private readonly memberRoles: MemberRoleService,
    // kick undo 토큰(Redis TTL 5초). 부재 시 undo 비활성(토큰 발급은 하되 검증 불가
    // 상황을 방지하기 위해 발급 자체를 best-effort 로 둔다 — 아래 kick 참조).
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  /**
   * FR-RM05: 멤버 강제 퇴장. WorkspaceMember 삭제 + 즉시 WS disconnect(outbox →
   * kickUserEverywhere) + 재초대 시 재가입 가능(BannedMember 미기록). 5초 Undo 토큰을
   * actor 에게만 반환한다(HTTP 응답 — 브로드캐스트 제외). AuditLog 필수.
   */
  async kick(args: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
    reason?: string;
  }): Promise<KickMemberResponse> {
    const { workspaceId, actorId, targetUserId } = args;
    const reason = normalizeReason(args.reason);
    const target = await this.assertTargetActionable(
      workspaceId,
      actorId,
      targetUserId,
      PERMISSIONS.KICK_MEMBERS,
    );
    // S72 (D13 / FR-W22 · reviewer MAJOR-2): kick 으로 삭제되는 멤버의 가입 ipHash 를
    // 스냅샷해 둔다. undo 재가입 시 이 값을 복원하지 않으면 kick→undo 후 ban 했을 때
    // IP 신호가 소실된다(BannedMember.ipHash 가 null). undo 토큰과 함께 Redis 에 저장한다.
    const kickedMember = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { ipHash: true },
    });
    const snapshotIpHash = kickedMember?.ipHash ?? null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.delete({
          where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        });
        // FR-RM05: kicked 은 재가입 가능 — BannedMember 를 남기지 않는다.
        await this.outbox.record(tx, {
          aggregateType: 'member',
          aggregateId: targetUserId,
          eventType: MEMBER_KICKED,
          payload: { workspaceId, userId: targetUserId, actorId },
        });
        // FR-RM17: 감사 로그(같은 tx — 원자성). reason 은 details 에만 싣는다.
        await this.audit.record(
          {
            workspaceId,
            actorId,
            action: AuditAction.MEMBER_KICK,
            targetId: targetUserId,
            details: reason ? { reason, previousRole: target.role } : { previousRole: target.role },
          },
          tx,
        );
      });
    } catch (e) {
      // B-1 (MAJOR-1): 대상이 그 사이 leave/remove 로 사라지면 delete 가 P2025 를 던진다
      // (동시 소멸 레이스). catch 없이는 500 이 됐다 — 도메인 404 로 변환해 관찰성과
      // ban 패턴(P2025/P2002 변환)을 일관되게 맞춘다.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new DomainError(
          ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
          'target user is no longer a member',
        );
      }
      throw e;
    }
    // 강등/삭제로 stale 권한 캐시가 남지 않게 무효화(best-effort).
    await this.memberRoles.invalidateMemberPermsCache(workspaceId, targetUserId);

    // FR-RM05: 5초 Undo 토큰. actor 가 자신의 HTTP 응답으로만 받는다(브로드캐스트
    // 제외). undoToken → 대상 userId 매핑을 Redis 에 TTL 5초로 저장한다.
    // S72 (D13 / FR-W22 · reviewer MAJOR-2): undo 재가입 시 ipHash 를 복원하기 위해 토큰과
    // 함께 kick 시점의 멤버 ipHash 를 JSON 으로 직렬화해 저장한다(레거시 평문 토큰 값과도
    // 호환되게 kickUndo 가 파싱을 폴백한다).
    const undoToken = randomUUID();
    const undoExpiresAt = new Date(Date.now() + KICK_UNDO_TTL_SECONDS * 1000);
    if (this.redis) {
      try {
        await this.redis.set(
          kickUndoKey(workspaceId, actorId, targetUserId),
          JSON.stringify({ token: undoToken, ipHash: snapshotIpHash }),
          'EX',
          KICK_UNDO_TTL_SECONDS,
        );
      } catch {
        // best-effort — Redis 부재/실패 시 undo 윈도가 없을 뿐 kick 은 확정됐다.
      }
    }
    return { undoToken, undoExpiresAt: undoExpiresAt.toISOString() };
  }

  /**
   * FR-RM05: kick 5초 Undo. actor 가 발급받은 undoToken 으로 대상을 재가입시킨다.
   * 토큰 만료/무효/이미 사용이면 409. 대상이 이미 재가입했거나(멤버 존재) 차단됐으면
   * 409(KICK_UNDO_INVALID 의미 확장 — undo 적용 불가 상태).
   */
  async kickUndo(args: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
    undoToken: string;
  }): Promise<void> {
    const { workspaceId, actorId, targetUserId, undoToken } = args;
    if (!this.redis) {
      // Redis 부재 시 undo 토큰을 검증할 수 없으므로 거부한다(보안 — 무토큰 재가입 금지).
      throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'undo window unavailable');
    }
    const key = kickUndoKey(workspaceId, actorId, targetUserId);
    const stored = await this.redis.get(key);
    if (!stored) {
      throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'undo token expired or invalid');
    }
    // S72 (D13 / FR-W22 · reviewer MAJOR-2): 저장값은 {token, ipHash} JSON 이다(레거시
    // 평문 토큰 값과도 호환되게 파싱 실패 시 stored 자체를 토큰으로 폴백). 토큰 검증 후
    // ipHash 를 복원해 kick→undo 후 ban 시 IP 신호가 소실되지 않게 한다.
    const { token: storedToken, ipHash: restoredIpHash } = parseUndoPayload(stored);
    if (storedToken !== undoToken) {
      throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'undo token expired or invalid');
    }
    // 토큰 1회용 — 즉시 삭제해 재사용을 막는다.
    await this.redis.del(key);

    // 대상이 그 사이 차단됐으면 undo 불가(차단 우선).
    const banned = await this.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { userId: true },
    });
    if (banned) {
      throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'target was banned after kick');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.create({
          // S72 (D13 / FR-W22 · reviewer MAJOR-2): kick 시점의 ipHash 를 복원한다(IP 신호 보존).
          data: {
            workspaceId,
            userId: targetUserId,
            role: WorkspaceRole.MEMBER,
            ipHash: restoredIpHash,
          },
        });
        // 재가입은 가입(invites.accept) 경로와 동일하게 MEMBER 시스템 MemberRole 을
        // 동기한다(enum ↔ 시스템 Role 불변식 — 누락 시 역할 관리 전부 거부됨).
        await syncMemberSystemRole(tx, workspaceId, targetUserId, 'MEMBER');
        await this.outbox.record(tx, {
          aggregateType: 'member',
          aggregateId: targetUserId,
          eventType: 'workspace.member.joined',
          payload: { workspaceId, userId: targetUserId, actorId },
        });
      });
    } catch (e) {
      // 대상이 이미 재가입(멤버 존재)했으면 P2002 — undo 적용 불가(409).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(ErrorCode.KICK_UNDO_INVALID, 'target already rejoined');
      }
      throw e;
    }
  }

  /**
   * FR-RM06: 멤버/비멤버 userId 영구 차단. BannedMember INSERT + (멤버이면)
   * WorkspaceMember 삭제 + 즉시 WS disconnect(force) + 재진입 불가(invites.accept
   * 체크). Undo 없음. 사유 + AuditLog 필수.
   *
   * 비멤버 userId 도 차단할 수 있어(가입 전 차단), 멤버일 때만 계층 방어/멤버 삭제를
   * 적용하고 비멤버는 권한 비트 검사 + 자기 자신 금지만 거친다.
   */
  async ban(args: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
    reason?: string;
  }): Promise<void> {
    const { workspaceId, actorId, targetUserId } = args;
    const reason = normalizeReason(args.reason);
    if (actorId === targetUserId) {
      throw new DomainError(ErrorCode.MODERATION_CANNOT_SELF, 'cannot ban yourself');
    }
    // 권한 비트 검사(BAN_MEMBERS). 비멤버 대상도 동일하게 actor 권한을 먼저 본다.
    const actor = await this.actorContext(workspaceId, actorId);
    if (!actor.isAdministrator && !hasRaw(actor.permissions, PERMISSIONS.BAN_MEMBERS)) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'you lack the BAN_MEMBERS permission',
      );
    }
    // 이미 차단됐으면 409(멱등이 아니라 명시 거부 — 중복 ban 은 상태 충돌).
    const already = await this.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { userId: true },
    });
    if (already) {
      throw new DomainError(ErrorCode.MEMBER_ALREADY_BANNED, 'user is already banned');
    }
    // 대상이 현재 멤버이면 계층 방어를 적용하고 삭제한다(비멤버면 INSERT 만).
    // S72 (D13 / FR-W22): 멤버라면 마지막 가입 ipHash 도 읽어 BannedMember.ipHash 로
    // 복사한다(같은 IP 의 후속 가입 soft-block 대조용). 비멤버 ban 은 ipHash 가 null.
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { role: true, ipHash: true },
    });
    let previousRole: WorkspaceRole | null = null;
    if (member) {
      if (member.role === WorkspaceRole.OWNER) {
        throw new DomainError(ErrorCode.MODERATION_TARGET_HIGHER, 'cannot ban the owner');
      }
      if (!actor.isAdministrator) {
        const targetTop = await this.topPosition(workspaceId, targetUserId, member.role);
        if (targetTop >= actor.topPosition) {
          throw new DomainError(
            ErrorCode.MODERATION_TARGET_HIGHER,
            'target outranks you — cannot ban a member at or above your highest role',
          );
        }
      }
      previousRole = member.role;
    } else if (!actor.isAdministrator) {
      // S63 fix-forward (security A-2 = MEDIUM · 비멤버 ban 타이밍 레이스): 대상이 ban
      // 직전 탈퇴(member=null)해도 잔존 MemberRole 이력으로 최고 position 을 추정해
      // 계층 비교를 적용한다. 멤버 삭제 시 MemberRole 은 cascade 로 함께 지워지는 게
      // 일반적이라 보통 빈 집합(topPosition=0 → 통과)이지만, 멤버 행만 사라지고 MemberRole
      // 이 남는 좁은 레이스에서는 MODERATOR 가 ADMIN 을 ban 하는 권한 상승을 막는다.
      // 이력이 전부 사라진 경우의 정밀 추정(과거 역할 스냅샷)은 역할 이력 테이블이 없어
      // carryover 다 — 현재는 잔존 MemberRole 기반 best-effort 비교로 창을 좁힌다.
      const residualRoles = await this.prisma.memberRole.findMany({
        where: { workspaceId, userId: targetUserId },
        select: { role: { select: { position: true } } },
      });
      if (residualRoles.length > 0) {
        const targetTop = residualRoles.reduce(
          (top, r) => (r.role.position > top ? r.role.position : top),
          0,
        );
        if (targetTop >= actor.topPosition) {
          throw new DomainError(
            ErrorCode.MODERATION_TARGET_HIGHER,
            'target outranks you — cannot ban a user at or above your highest role',
          );
        }
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.bannedMember.create({
          // S72 (D13 / FR-W22): 멤버였던 대상의 마지막 가입 ipHash 를 함께 저장한다(같은
          // IP 의 후속 가입 soft-block 대조용). 비멤버 ban 이면 member=null → ipHash 미저장.
          data: {
            workspaceId,
            userId: targetUserId,
            bannedBy: actorId,
            reason,
            ipHash: member?.ipHash ?? null,
          },
        });
        if (member) {
          await tx.workspaceMember.delete({
            where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
          });
          // 멤버였던 대상만 disconnect 이벤트가 의미 있다(비멤버는 소켓 룸 없음 — no-op).
          await this.outbox.record(tx, {
            aggregateType: 'member',
            aggregateId: targetUserId,
            eventType: MEMBER_BANNED,
            payload: { workspaceId, userId: targetUserId, actorId },
          });
        }
        await this.audit.record(
          {
            workspaceId,
            actorId,
            action: AuditAction.MEMBER_BAN,
            targetId: targetUserId,
            details: {
              ...(reason ? { reason } : {}),
              ...(previousRole ? { previousRole } : {}),
              wasMember: member !== null,
            },
          },
          tx,
        );
      });
    } catch (e) {
      // 동시 ban 레이스: BannedMember PK 충돌 → 이미 차단(409).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(ErrorCode.MEMBER_ALREADY_BANNED, 'user is already banned');
      }
      throw e;
    }
    if (member) {
      await this.memberRoles.invalidateMemberPermsCache(workspaceId, targetUserId);
    }
  }

  /** FR-RM06: 차단 해제. 관리자가 BannedMember 행을 제거한다. 미차단이면 404. */
  async unban(args: { workspaceId: string; actorId: string; targetUserId: string }): Promise<void> {
    const { workspaceId, actorId, targetUserId } = args;
    const actor = await this.actorContext(workspaceId, actorId);
    if (!actor.isAdministrator && !hasRaw(actor.permissions, PERMISSIONS.BAN_MEMBERS)) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'you lack the BAN_MEMBERS permission',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.bannedMember.deleteMany({
        where: { workspaceId, userId: targetUserId },
      });
      if (result.count === 0) {
        throw new DomainError(ErrorCode.MEMBER_NOT_BANNED, 'user is not banned');
      }
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: AuditAction.MEMBER_UNBAN,
          targetId: targetUserId,
        },
        tx,
      );
    });
  }

  /** FR-RM06: 워크스페이스 차단 목록(권한자). 최신 차단 순. */
  async listBans(args: { workspaceId: string; actorId: string }): Promise<ListBansResponse> {
    const { workspaceId, actorId } = args;
    const actor = await this.actorContext(workspaceId, actorId);
    if (!actor.isAdministrator && !hasRaw(actor.permissions, PERMISSIONS.BAN_MEMBERS)) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'you lack the BAN_MEMBERS permission',
      );
    }
    const rows = await this.prisma.bannedMember.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    // 대상 사용자 표시 정보(비멤버 차단도 User 행은 존재할 수 있음 — best-effort 조회).
    const userIds = rows.map((r) => r.userId);
    const users =
      userIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, email: true },
          });
    const userMap = new Map(users.map((u) => [u.id, u]));
    const bans: BannedMember[] = rows.map((r) => ({
      workspaceId: r.workspaceId,
      userId: r.userId,
      bannedBy: r.bannedBy,
      reason: r.reason ?? null,
      createdAt: r.createdAt.toISOString(),
      user: userMap.get(r.userId) ?? null,
    }));
    return { bans };
  }

  /**
   * FR-RM07: 멤버 임시 음소거(타임아웃). durationSeconds(60~2419200=28일) 만큼 mutedUntil 을
   * now+duration 으로 설정한다. 기간 중 SEND_MESSAGES/ADD_REACTIONS/USE_SLASH_COMMANDS 가
   * 차단되고(메시지/반응 게이트에서 lazy 검사), VIEW_CHANNEL/READ_HISTORY 는 유지된다.
   * 만료는 lazy(별도 sweep 불요). AuditLog 필수.
   */
  async timeout(args: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
    durationSeconds: number;
    reason?: string;
  }): Promise<TimeoutMemberResponse> {
    const { workspaceId, actorId, targetUserId, durationSeconds } = args;
    const reason = normalizeReason(args.reason);
    await this.assertTargetActionable(
      workspaceId,
      actorId,
      targetUserId,
      PERMISSIONS.TIMEOUT_MEMBERS,
    );
    const mutedUntil = new Date(Date.now() + durationSeconds * 1000);
    await this.runMemberWrite(async () => {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
          data: { mutedUntil },
        });
        await this.audit.record(
          {
            workspaceId,
            actorId,
            action: AuditAction.MEMBER_TIMEOUT,
            targetId: targetUserId,
            details: {
              durationSeconds,
              mutedUntil: mutedUntil.toISOString(),
              ...(reason ? { reason } : {}),
            },
          },
          tx,
        );
      });
    });
    return { userId: targetUserId, mutedUntil: mutedUntil.toISOString() };
  }

  /**
   * FR-RM10a (063): 시스템(AutoMod) 발 타임아웃. 인간 모더레이터가 아니라 AutoMod 규칙
   * 적용 결과로 작성자 본인을 음소거하므로, 권한 비트 검사·self 가드·계층 방어를 적용하지
   * 않는다(actor 가 시스템이라 의미 없음). mutedUntil 만 갱신하고 AUTOMOD_TIMEOUT 감사를
   * 남긴다(actorId = targetUserId — 시스템 액션이지만 감사 무결성상 대상을 actor 로 표기).
   * 대상이 더 이상 멤버가 아니면(레이스) WORKSPACE_TARGET_NOT_MEMBER(404)로 변환(호출부
   * best-effort 라 로그만 남고 흡수된다).
   */
  async timeoutBySystem(args: {
    workspaceId: string;
    targetUserId: string;
    durationSeconds: number;
    reason?: string;
  }): Promise<TimeoutMemberResponse> {
    const { workspaceId, targetUserId, durationSeconds } = args;
    const reason = normalizeReason(args.reason);
    const mutedUntil = new Date(Date.now() + durationSeconds * 1000);
    await this.runMemberWrite(async () => {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
          data: { mutedUntil },
        });
        await this.audit.record(
          {
            workspaceId,
            actorId: targetUserId,
            action: AuditAction.AUTOMOD_TIMEOUT,
            targetId: targetUserId,
            details: {
              durationSeconds,
              mutedUntil: mutedUntil.toISOString(),
              ...(reason ? { reason } : {}),
            },
          },
          tx,
        );
      });
    });
    await this.memberRoles
      .invalidateMemberPermsCache(workspaceId, targetUserId)
      .catch(() => undefined);
    return { userId: targetUserId, mutedUntil: mutedUntil.toISOString() };
  }

  /** FR-RM07: 음소거 수동 해제. mutedUntil 을 null 로 되돌린다. AuditLog 필수. */
  async untimeout(args: {
    workspaceId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<void> {
    const { workspaceId, actorId, targetUserId } = args;
    await this.assertTargetActionable(
      workspaceId,
      actorId,
      targetUserId,
      PERMISSIONS.TIMEOUT_MEMBERS,
    );
    await this.runMemberWrite(async () => {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
          data: { mutedUntil: null },
        });
        await this.audit.record(
          {
            workspaceId,
            actorId,
            action: AuditAction.MEMBER_UNTIMEOUT,
            targetId: targetUserId,
          },
          tx,
        );
      });
    });
  }

  /**
   * S69 (D13 / FR-W11 · Fork A): 일괄 멤버 관리(kick/timeout/role). 최대 100명을
   * **단일 트랜잭션**으로 처리하고 **단일 AuditLog** + 대상별 outbox(소켓 disconnect /
   * 역할 캐시 무효화 트리거)를 남긴다. BullMQ 미사용(동기 단일 tx).
   *
   * 부분실패 정책: 권한 비트 검사는 actor 단위로 한 번(부족하면 전체 403). 그 통과 뒤
   * 대상별로 self/비멤버/OWNER/계층(outranked)/역할무효 를 검사해 **건너뛴 대상은
   * skipped 에 사유와 함께** 남기고, 적용 가능한 대상만 affected 로 모아 deleteMany
   * (kick)/updateMany(timeout·role) 한다. 한 명이라도 부적격이어도 나머지는 적용된다
   * (all-or-nothing 이 아니라 적격분만 — 대규모 일괄 관리의 실용성). 트랜잭션은 affected
   * 집합 전체의 write + audit + outbox 를 한 commit 으로 묶어 원자성을 보장한다.
   */
  async bulkAction(args: {
    workspaceId: string;
    actorId: string;
    // role 액션 권한 게이트(ADMIN+) 판정에 쓰는 actor 의 시스템 역할 enum.
    actorRole: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
    action: BulkMemberAction;
    userIds: string[];
    durationSeconds?: number;
    role?: 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
  }): Promise<BulkMemberActionResponse> {
    const { workspaceId, actorId, actorRole, action, durationSeconds, role } = args;
    // 중복 userId 제거(동일 대상 중복 카운트 방지).
    const userIds = [...new Set(args.userIds)];
    const attemptedCount = userIds.length;

    const actor = await this.actorContext(workspaceId, actorId);
    // 1) actor 권한 게이트(액션별). 부족하면 전체 403(부분 적용 없음).
    //    - kick:    KICK_MEMBERS 비트(또는 ADMINISTRATOR) — MODERATOR 도 비트 보유 시 가능.
    //    - timeout: TIMEOUT_MEMBERS 비트(또는 ADMINISTRATOR).
    //    - role:    역할 변경은 비트가 아니라 ADMIN+ enum 계층(또는 ADMINISTRATOR)로 게이트한다
    //               (단건 updateRole 의 @Roles('ADMIN') 와 동일 기준 — MODERATOR 는 역할변경 불가).
    if (action === 'role') {
      const isAdminPlus = actor.isAdministrator || ROLE_RANK[actorRole] >= ROLE_RANK.ADMIN;
      if (!isAdminPlus) {
        throw new DomainError(
          ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
          'role changes require ADMIN or higher',
        );
      }
    } else {
      const requiredBit =
        action === 'kick' ? PERMISSIONS.KICK_MEMBERS : PERMISSIONS.TIMEOUT_MEMBERS;
      if (!actor.isAdministrator && !hasRaw(actor.permissions, requiredBit)) {
        throw new DomainError(
          ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
          'you lack the required permission for this bulk action',
        );
      }
    }

    // 2) 대상별 적격성 판정(권한 통과 후 계층/소유권/자기자신/비멤버/역할무효).
    const targets = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: userIds } },
      select: { userId: true, role: true },
    });
    const targetMap = new Map(targets.map((t) => [t.userId, t]));

    const affected: string[] = [];
    const skipped: Array<{ userId: string; reason: BulkMemberSkipReason }> = [];

    // S69 fix-forward (perf SERIOUS-1): 비-administrator actor 의 계층 판정에 쓰는 대상별
    // top-position 을 **단일 조회 + Map 룩업**으로 미리 구한다. 종전엔 대상마다 topPosition
    // (findMany)을 tx 밖에서 순차 await 해 100명 기준 ~100 라운드트립이 났다. OWNER/self/
    // 비멤버는 어차피 계층 비교 전에 skip 되므로 not-owner 멤버만 조회 대상이다.
    const topByUser = new Map<string, number>();
    if (!actor.isAdministrator) {
      const notOwnerIds = targets
        .filter((t) => t.role !== WorkspaceRole.OWNER)
        .map((t) => t.userId);
      if (notOwnerIds.length > 0) {
        const memberRoles = await this.prisma.memberRole.findMany({
          where: { workspaceId, userId: { in: notOwnerIds } },
          select: { userId: true, role: { select: { position: true } } },
        });
        for (const mr of memberRoles) {
          const prev = topByUser.get(mr.userId) ?? 0;
          if (mr.role.position > prev) topByUser.set(mr.userId, mr.role.position);
        }
      }
    }

    for (const userId of userIds) {
      if (userId === actorId) {
        skipped.push({ userId, reason: 'self' });
        continue;
      }
      const target = targetMap.get(userId);
      if (!target) {
        skipped.push({ userId, reason: 'not_member' });
        continue;
      }
      if (target.role === WorkspaceRole.OWNER) {
        skipped.push({ userId, reason: 'owner' });
        continue;
      }
      // role 액션: 동일 역할로의 변경은 no-op 이지만(affected 포함 후 updateMany 가 자연히
      // 멱등) OWNER 로의 변경은 스키마에서 이미 차단(타입).
      if (!actor.isAdministrator) {
        // MemberRole 행이 없으면(레거시 멤버) 시스템 역할 enum 기본 position 으로 폴백한다
        // (topPosition() 와 동일 규칙 — 단건과 정합).
        const targetTop = topByUser.get(userId) ?? SYSTEM_ROLE_POSITION[target.role] ?? 0;
        if (targetTop >= actor.topPosition) {
          skipped.push({ userId, reason: 'outranked' });
          continue;
        }
      }
      affected.push(userId);
    }

    if (affected.length === 0) {
      return { action, attemptedCount, affected: [], skipped };
    }

    // 3) 단일 트랜잭션: 적격 대상 일괄 write + 단일 AuditLog + 대상별 outbox.
    const mutedUntil =
      action === 'timeout' && durationSeconds !== undefined
        ? new Date(Date.now() + durationSeconds * 1000)
        : null;

    await this.prisma.$transaction(async (tx) => {
      if (action === 'kick') {
        await tx.workspaceMember.deleteMany({
          where: { workspaceId, userId: { in: affected } },
        });
        for (const userId of affected) {
          await this.outbox.record(tx, {
            aggregateType: 'member',
            aggregateId: userId,
            eventType: MEMBER_KICKED,
            payload: { workspaceId, userId, actorId },
          });
        }
      } else if (action === 'timeout') {
        await tx.workspaceMember.updateMany({
          where: { workspaceId, userId: { in: affected } },
          data: { mutedUntil },
        });
      } else {
        // role 변경: updateMany 로 enum 일괄 변경 + 시스템 MemberRole **일괄 동기**(SERIOUS-2)
        // + 대상별 ROLE_CHANGED. 종전엔 대상마다 syncMemberSystemRole(3쿼리)을 돌려 tx 안에
        // 100×3 쿼리 + 긴 락이 쌓였다. 이제 syncMembersSystemRole 이 시스템 역할 1회 조회 +
        // 단일 deleteMany + 단일 createMany 로 동기한다.
        const nextRole = role as 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
        await tx.workspaceMember.updateMany({
          where: { workspaceId, userId: { in: affected } },
          data: { role: WorkspaceRole[nextRole] },
        });
        await syncMembersSystemRole(tx, workspaceId, affected, nextRole);
        for (const userId of affected) {
          await this.outbox.record(tx, {
            aggregateType: 'member',
            aggregateId: userId,
            eventType: ROLE_CHANGED,
            payload: {
              workspaceId,
              userId,
              actorId,
              from: targetMap.get(userId)?.role ?? null,
              to: WorkspaceRole[nextRole],
            },
          });
        }
      }

      // 단일 AuditLog(Fork A) — affected/skipped 전부를 details 에 싣는다.
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: AuditAction.MEMBER_BULK_ACTION,
          targetId: null,
          details: {
            bulkAction: action,
            affected,
            skipped,
            ...(action === 'timeout' && durationSeconds !== undefined
              ? { durationSeconds, mutedUntil: mutedUntil?.toISOString() ?? null }
              : {}),
            ...(action === 'role' && role ? { role } : {}),
          },
        },
        tx,
      );
    });

    // 4) 강등/삭제/타임아웃으로 stale 권한 캐시가 남지 않게 일괄 무효화(perf MODERATE-2 ·
    //    채널 목록 1회 조회 + affected 전체 단일 DEL pipeline). best-effort.
    await this.memberRoles.invalidateMembersPermsCache(workspaceId, affected);

    return { action, attemptedCount, affected, skipped };
  }

  /**
   * B-1 (MAJOR-1): WorkspaceMember 대상 write(update/delete)를 감싸 P2025(record not
   * found · 동시 leave/remove 레이스)를 도메인 404 로 변환한다. assertTargetActionable
   * 통과 후 트랜잭션 커밋 사이에 대상이 탈퇴/제거되면 Prisma 가 P2025 를 던지는데,
   * catch 없이는 500 이 됐다 — kick 의 delete 및 ban 의 P2002 변환과 일관되게 404 로
   * 수렴시켜 관찰성을 맞춘다.
   */
  private async runMemberWrite<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new DomainError(
          ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
          'target user is no longer a member',
        );
      }
      throw e;
    }
  }

  /**
   * FR-RM07: 타임아웃 lazy 게이트. 대상 멤버의 mutedUntil 이 미래면 true(음소거 중).
   * 만료(<=now)·null 이면 false(자동 통과 — 별도 sweep 불요). 메시지 send / 반응 /
   * 슬래시 경로가 호출해 MEMBER_TIMED_OUT(403) 으로 거부한다. DM(워크스페이스 없음)은
   * workspaceId=null 이라 호출되지 않는다.
   */
  async isTimedOut(workspaceId: string, userId: string, now: Date = new Date()): Promise<boolean> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { mutedUntil: true },
    });
    return member?.mutedUntil != null && member.mutedUntil.getTime() > now.getTime();
  }

  /**
   * FR-RM06: 초대 수락 시 재진입 차단 검사. invites.service.accept 가 호출한다.
   * (workspaceId, userId) BannedMember 가 존재하면 true.
   */
  async isBanned(workspaceId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.bannedMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    return row !== null;
  }

  // ── 공유 가드 ────────────────────────────────────────────────────────────────

  /**
   * S64 fix-forward (security A-1 = BLOCKER-1 = reviewer M-1): position 계층 단독 검증.
   *
   * 신고 처리 DELETE_MESSAGE 가 대상 메시지 작성자에 대해 position 계층을 강제하는 데
   * 쓴다(채널 DELETE_ANY_MESSAGE 비트 게이트는 호출부가 별도로 수행). assertTargetActionable
   * 과 같은 계층 규칙이되, 모더레이션 권한 비트 검사는 빼고 "actor 가 author 보다 상위인가"
   * 만 본다(MODERATOR 가 ADMIN/OWNER 메시지를 삭제하는 권한 상승을 막는다):
   *   - actor == author 면 항상 허용(자기 메시지 삭제).
   *   - author 가 워크스페이스 멤버가 아니면(이미 탈퇴/비멤버) position 비교 생략(통과).
   *   - author 가 OWNER 면 거부(최상위).
   *   - actor 가 ADMINISTRATOR 면 면제(통과).
   *   - 그 외: author 의 최고 position 이 actor 이상이면 MODERATION_TARGET_HIGHER(403).
   */
  async assertActorOutranksAuthor(
    workspaceId: string,
    actorId: string,
    authorId: string,
  ): Promise<void> {
    if (actorId === authorId) return;
    const actor = await this.actorContext(workspaceId, actorId);
    if (actor.isAdministrator) return;
    const author = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: authorId } },
      select: { role: true },
    });
    // 작성자가 더 이상 멤버가 아니면 계층 비교 대상이 없다 — 채널 권한 비트로 충분.
    if (!author) return;
    if (author.role === WorkspaceRole.OWNER) {
      throw new DomainError(ErrorCode.MODERATION_TARGET_HIGHER, 'cannot delete the owner message');
    }
    const authorTop = await this.topPosition(workspaceId, authorId, author.role);
    if (authorTop >= actor.topPosition) {
      throw new DomainError(
        ErrorCode.MODERATION_TARGET_HIGHER,
        'target outranks you — cannot delete a message authored at or above your highest role',
      );
    }
  }

  /**
   * S63 권한 게이트 + 계층 방어 공통 진입점:
   *   1. 자기 자신 대상 금지(MODERATION_CANNOT_SELF).
   *   2. actor 가 해당 모더레이션 비트(또는 ADMINISTRATOR)를 보유하는지 검사(403).
   *   3. 대상이 현재 멤버이면 actor 보다 상위 position 이 아닌지 검사(MODERATION_TARGET_HIGHER).
   *      OWNER 대상은 항상 거부(최상위). actor 가 ADMINISTRATOR 면 position 면제.
   *
   * 반환: 대상의 현재 WorkspaceMember(audit details 의 previousRole 용).
   */
  private async assertTargetActionable(
    workspaceId: string,
    actorId: string,
    targetUserId: string,
    requiredBit: bigint,
  ): Promise<{ role: WorkspaceRole }> {
    if (actorId === targetUserId) {
      throw new DomainError(ErrorCode.MODERATION_CANNOT_SELF, 'cannot moderate yourself');
    }
    const actor = await this.actorContext(workspaceId, actorId);
    if (!actor.isAdministrator && !hasRaw(actor.permissions, requiredBit)) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'you lack the required moderation permission',
      );
    }
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { role: true },
    });
    if (!target) {
      throw new DomainError(ErrorCode.WORKSPACE_TARGET_NOT_MEMBER, 'target user is not a member');
    }
    // OWNER 는 어떤 모더레이션 대상도 될 수 없다(최상위 — transfer-ownership 전용).
    if (target.role === WorkspaceRole.OWNER) {
      throw new DomainError(ErrorCode.MODERATION_TARGET_HIGHER, 'cannot moderate the owner');
    }
    // S61 계층 방어: 대상의 최고 position 이 actor 의 최고 position 이상이면 거부한다.
    // ADMINISTRATOR 보유 actor 는 면제(최상위 권한).
    if (!actor.isAdministrator) {
      const targetTop = await this.topPosition(workspaceId, targetUserId, target.role);
      if (targetTop >= actor.topPosition) {
        throw new DomainError(
          ErrorCode.MODERATION_TARGET_HIGHER,
          'target outranks you — cannot moderate a member at or above your highest role',
        );
      }
    }
    return target;
  }

  /** actor 의 최고 position · 권한 OR · ADMINISTRATOR 여부(MemberRoleService 패턴 재사용). */
  private async actorContext(
    workspaceId: string,
    actorUserId: string,
  ): Promise<{ topPosition: number; permissions: bigint; isAdministrator: boolean }> {
    const roles = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId: actorUserId },
      select: { role: { select: { position: true, permissions: true } } },
    });
    let topPosition = 0;
    let permissions = 0n;
    for (const r of roles) {
      if (r.role.position > topPosition) topPosition = r.role.position;
      permissions |= fromStoragePermissions(r.role.permissions);
    }
    return {
      topPosition,
      permissions,
      isAdministrator: hasRaw(permissions, PERMISSIONS.ADMINISTRATOR),
    };
  }

  /**
   * 대상의 최고 역할 position. MemberRole 행이 있으면 그 최댓값을, 없으면(레거시
   * 멤버) 시스템 역할 enum 의 기본 position 으로 폴백한다(계층 비교가 항상 가능하게).
   */
  private async topPosition(
    workspaceId: string,
    userId: string,
    fallbackRole: WorkspaceRole,
  ): Promise<number> {
    const roles = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId },
      select: { role: { select: { position: true } } },
    });
    if (roles.length === 0) {
      return SYSTEM_ROLE_POSITION[fallbackRole] ?? 0;
    }
    return roles.reduce((top, r) => (r.role.position > top ? r.role.position : top), 0);
  }
}

/** FR-RM05: kick undo Redis 키. actor·target 쌍으로 스코프해 충돌을 막는다. */
function kickUndoKey(workspaceId: string, actorId: string, targetUserId: string): string {
  return `kick_undo:${workspaceId}:${actorId}:${targetUserId}`;
}

/**
 * S72 (D13 / FR-W22 · reviewer MAJOR-2): kick undo Redis 저장값을 {token, ipHash} 로 파싱한다.
 * 신규 값은 JSON 직렬화돼 있고, TTL 5초 내 잔존할 수 있는 레거시 평문 토큰 값(또는 파싱
 * 불가)은 stored 자체를 토큰으로 보고 ipHash 는 null 로 폴백한다(하위호환 — undo 동작 보존).
 */
function parseUndoPayload(stored: string): { token: string; ipHash: string | null } {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { token?: unknown }).token === 'string'
    ) {
      const obj = parsed as { token: string; ipHash?: unknown };
      return { token: obj.token, ipHash: typeof obj.ipHash === 'string' ? obj.ipHash : null };
    }
  } catch {
    // 레거시 평문 토큰 값 — JSON 이 아니면 stored 자체가 토큰.
  }
  return { token: stored, ipHash: null };
}

/** 사유 정규화 — trim 후 빈 문자열이면 null(미제공 취급). Zod 가 길이는 이미 검증. */
function normalizeReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}
