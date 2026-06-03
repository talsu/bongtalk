import { Inject, Injectable, Optional } from '@nestjs/common';
import type { WorkspaceRole } from '@prisma/client';
import type Redis from 'ioredis';
import { PERMISSIONS, fromStoragePermissions } from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { Permission, ROLE_BASELINE } from '../../auth/permissions';
import { REDIS } from '../../redis/redis.module';
import { roleCacheKey } from '../../queue/role-cache-queue.constants';
import {
  resolveChannelPermissions,
  type ResolverRole,
} from '../../workspaces/roles/role-permission-resolver';
import { bigintToEnforcementMask } from './bigint-to-enforcement';

/**
 * S44 (FR-MN-02 / FR-MN-16 / ADR-4): `MENTION_EVERYONE` 카탈로그 비트(0x0080).
 *
 * ⚠️ D12 carryover: 집행 enum(`auth/permissions.ts`)의 0x0080 은 PIN_MESSAGE 라
 * 동일 비트 위치를 공유한다. 멘션 게이트는 PRD 지시대로 **카탈로그 비트**(여기
 * 정의)를 직접 검사한다. `ChannelPermissionOverride.allow/denyMask`(Int)에 이
 * 비트가 켜져 있으면 MENTION_EVERYONE 권한 부여/박탈로 해석한다. number 비트필드
 * 로 다루므로 BigInt 카탈로그 값을 Number 로 좁혀 모듈 상수로 고정한다(0x0080).
 */
const MENTION_EVERYONE_BIT = Number(PERMISSIONS.MENTION_EVERYONE);

/**
 * S44: 역할별 `MENTION_EVERYONE` 기본값(base). OWNER/ADMIN 은 on, MEMBER 는 off.
 * 채널 override 가 이 base 위에 5단계 fold 로 누적된다.
 */
const MENTION_EVERYONE_ROLE_BASE: Record<WorkspaceRole, number> = {
  OWNER: MENTION_EVERYONE_BIT,
  ADMIN: MENTION_EVERYONE_BIT,
  // S61: MODERATOR 는 staff 등급으로 @everyone/@here 기본 허용. MEMBER/GUEST 는 off
  // (채널 override allow 로만 부여 가능).
  MODERATOR: MENTION_EVERYONE_BIT,
  MEMBER: 0,
  GUEST: 0,
};

/**
 * Task-014-A (task-012-follow-13 closure): single source of truth for
 * channel ACL. Both `ChannelAccessGuard` (loads `:chid` from the URL
 * path, enforces visibility + archived state) and `ChannelAccessByIdGuard`
 * (called from controllers when the channel id lives in the body) now
 * delegate here. The previous guards each had their own override-lookup
 * + mask-compute logic; diverging implementations meant a permission
 * model change required 2-file diffs and 012-review caught one such
 * drift. Folding it into one service keeps the permission model
 * testable in isolation.
 */
@Injectable()
export class ChannelAccessService {
  /**
   * S62 (FR-RM14): 역할 권한 캐시 TTL(초). PRD "override 즉시반영" 요건상 ≤5초로
   * 둔다 — miss 시 DB 재계산이라 stale window 는 최대 이 값이고, override 변경 경로는
   * 명시 DEL 로 300ms 내에 무효화한다(channels.service). 캐시는 best-effort(Redis
   * 미주입 환경/테스트에서는 항상 miss → DB 계산).
   */
  private static readonly PERMS_CACHE_TTL_SECONDS = 5;

  constructor(
    private readonly prisma: PrismaService,
    // S62 (FR-RM14): role-cache read-through. @Global RedisModule 이 제공하며,
    // 테스트/Redis 부재 환경에서는 Optional 로 undefined → 캐시 우회.
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  /**
   * Compute the caller's effective permission mask on a channel.
   * Throws `WORKSPACE_NOT_MEMBER` when the caller isn't a member of
   * the channel's workspace — guards above this are expected to have
   * proven workspace membership already, but we repeat the check here
   * because callers like the attachment presign endpoint run without
   * `WorkspaceMemberGuard` upstream.
   */
  async resolveEffective(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
  ): Promise<number> {
    // task-034-A: DIRECT channels have workspaceId=null. Access is
    // expressed solely via ChannelPermissionOverride (USER rows the
    // DirectMessagesService creates) — skip the workspace-member gate.
    if (channel.workspaceId === null) {
      const overrides = await this.prisma.channelPermissionOverride.findMany({
        where: { channelId: channel.id, principalType: 'USER', principalId: userId },
      });
      let allow = 0;
      let deny = 0;
      for (const o of overrides) {
        // S61: allow/denyMask 는 Prisma BigInt 로 전환됐다. 채널 overwrite 마스크는
        // 13비트(≤0x1FFF)만 담아 number 안전범위 내이므로 집행 계산(0xFF 도메인)에서
        // Number 로 좁힌다. ADMINISTRATOR 는 override 에 저장되지 않는다(Role 전용).
        allow |= Number(o.allowMask);
        deny |= Number(o.denyMask);
      }
      return allow & ~deny;
    }
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: channel.workspaceId, userId } },
      select: {
        role: true,
        // S62 (FR-RM03): 커스텀 Role 반영. 멤버가 보유한 모든 Role(시스템 backfill +
        // 커스텀)을 함께 로드해 base 권한 OR + 역할 UUID override 조회에 쓴다.
        memberRoles: {
          select: { role: { select: { id: true, permissions: true, position: true } } },
        },
      },
    });
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'not a workspace member');
    }
    return this.computeEffectiveForMember(channel, userId, member);
  }

  /**
   * S62 (FR-RM03 · Fork A): 커스텀 Role 을 반영한 집행 마스크 계산.
   *
   * 두 도메인을 분리해 회귀를 최소화한다(★ 기존 워크스페이스 결과 == ROLE_BASELINE):
   *   1. **base(카탈로그 → 집행)**: 멤버가 보유한 모든 Role 의 카탈로그 permissions 를
   *      `resolveChannelPermissions`(②역할 OR · overwrite 없이) 로 합산한 뒤
   *      `bigintToEnforcementMask` 로 집행 number 비트로 변환한다. 시스템 역할만 가진
   *      레거시 멤버는 SYSTEM_ROLE_PERMISSIONS → ROLE_BASELINE 과 정확히 일치한다
   *      (bigint-to-enforcement.spec 가 잠금). MemberRole 이 비어 있는 레거시 멤버는
   *      enum role 의 ROLE_BASELINE 으로 폴백한다(backfill 누락 방어).
   *   2. **override(집행 도메인 5단계 fold)**: 채널 overwrite 마스크는 집행 비트필드로
   *      저장되므로(controller 가 enforcement ALL_PERMISSIONS 로 검증), 카탈로그로
   *      재해석하지 않고 PermissionMatrix.fold 와 동일한 5단계 누적을 그대로 쓴다.
   *      역할 tier 에는 enum 리터럴 ROLE override(레거시) + 커스텀 Role UUID override 를
   *      함께 넣는다. 개인(USER) override 가 최우선.
   *
   * private 채널 가시성 게이트(base 억제 후 READ ALLOW 로만 개방)도 보존한다.
   */
  private async computeEffectiveForMember(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
    member: {
      role: WorkspaceRole;
      memberRoles: Array<{ role: { id: string; permissions: bigint; position: number } }>;
    },
  ): Promise<number> {
    const roleIds = member.memberRoles.map((m) => m.role.id);

    // ── 캐시 read-through(FR-RM14): perms:{channelId}:{userId} ──────────────────
    // 멤버의 유효 집행 마스크는 (보유 역할 base + 본인 USER override + 적용 ROLE
    // override) 의 함수라 per-(channel, user) 로 캐시한다. 무효화는 channels.service
    // 가 override upsert 직후 perms:{channelId}:* 를 DEL 해 300ms 내에 반영한다
    // (FR-RM14). roleCacheKey 규약(perms:{channelId}:{principal})을 재사용한다.
    const cacheKey = roleCacheKey(channel.id, userId);
    const cached = await this.cacheGet(cacheKey);
    if (cached !== null) return cached;

    // 1. base 권한(카탈로그 → 집행).
    const enforcementBase = this.computeEnforcementBase(member);

    // 2. 채널 overwrite(집행 도메인). USER=본인 + ROLE=enum 리터럴(레거시) + ROLE=UUID.
    const rolePrincipalIds = [member.role as string, ...roleIds];
    const overrides = await this.prisma.channelPermissionOverride.findMany({
      where: {
        channelId: channel.id,
        OR: [
          { principalType: 'USER', principalId: userId },
          { principalType: 'ROLE', principalId: { in: rolePrincipalIds } },
        ],
      },
      select: { principalType: true, principalId: true, allowMask: true, denyMask: true },
    });

    const roleAllow = overrides
      .filter((o) => o.principalType === 'ROLE')
      .reduce((m, o) => m | Number(o.allowMask), 0);
    const roleDeny = overrides
      .filter((o) => o.principalType === 'ROLE')
      .reduce((m, o) => m | Number(o.denyMask), 0);
    const userAllow = overrides
      .filter((o) => o.principalType === 'USER')
      .reduce((m, o) => m | Number(o.allowMask), 0);
    const userDeny = overrides
      .filter((o) => o.principalType === 'USER')
      .reduce((m, o) => m | Number(o.denyMask), 0);

    // OWNER 무조건 가시(PermissionMatrix.effective 의 MED-6 정합) — base 억제 면제.
    // OWNER 는 ADMINISTRATOR 보유라 enforcementBase = ALL_PERMISSIONS.
    const isOwner = member.role === 'OWNER';
    let base = enforcementBase;
    if (channel.isPrivate && !isOwner) {
      // private 가시성 게이트: 명시 READ ALLOW(USER 또는 ROLE) 가 있어야 base 개방.
      const hasExplicitRead = ((userAllow | roleAllow) & Permission.READ) === Permission.READ;
      base = hasExplicitRead ? enforcementBase : 0;
    }

    // 5단계 fold(나중 = 우선): base → roleAllow → roleDeny → userAllow → userDeny.
    let mask = base;
    mask |= roleAllow;
    mask &= ~roleDeny;
    mask |= userAllow;
    mask &= ~userDeny;
    const effective = mask >>> 0;

    await this.cacheSet(cacheKey, effective);
    return effective;
  }

  /**
   * S62 (FR-RM03): 멤버가 보유한 모든 Role 의 카탈로그 permissions 를 OR 합산해
   * 집행 base 마스크로 변환한다. MemberRole 이 비어 있으면(backfill 누락 레거시)
   * enum role 의 ROLE_BASELINE 으로 폴백한다(권한 공백 방어).
   */
  private computeEnforcementBase(member: {
    role: WorkspaceRole;
    memberRoles: Array<{ role: { id: string; permissions: bigint; position: number } }>;
  }): number {
    if (member.memberRoles.length === 0) {
      return ROLE_BASELINE[member.role] ?? 0;
    }
    const roles: ResolverRole[] = member.memberRoles.map((m) => ({
      id: m.role.id,
      permissions: fromStoragePermissions(m.role.permissions),
      position: m.role.position,
      isEveryone: false,
    }));
    // resolveChannelPermissions 의 ②역할 OR(+ ADMINISTRATOR 단락)만 사용한다 — 채널
    // overwrite 는 집행 도메인에서 별도 적용하므로 여기서는 넘기지 않는다. everyone 은
    // 가장 낮은 역할을 대표로 넘기고 나머지를 memberRoles 로 OR 한다(순수 합산이라
    // 어느 것을 everyone 으로 두든 결과 동일).
    const [first, ...rest] = roles;
    const catalogBase = resolveChannelPermissions({
      everyone: { ...first, isEveryone: true },
      memberRoles: rest,
    });
    return bigintToEnforcementMask(catalogBase);
  }

  /** S62 (FR-RM14): 권한 캐시 GET. miss/Redis 부재/파싱 실패 시 null. best-effort. */
  private async cacheGet(key: string): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  /** S62 (FR-RM14): 권한 캐시 SET(TTL ≤5초). best-effort(실패 무시). */
  private async cacheSet(key: string, value: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, String(value), 'EX', ChannelAccessService.PERMS_CACHE_TTL_SECONDS);
    } catch {
      // best-effort — 캐시 실패는 권한 계산 정확성에 영향 없음(다음 호출 시 DB 재계산).
    }
  }

  /**
   * Throws the right error code when the caller doesn't have `required`.
   * Private channels get `CHANNEL_NOT_VISIBLE` (no information leak);
   * public channels where the member exists but lacks the bit get
   * `FORBIDDEN` so the E2E can distinguish 404-style from 403-style.
   */
  async requirePermission(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
    required: Permission,
  ): Promise<void> {
    const effective = await this.resolveEffective(channel, userId);
    if ((effective & required) !== required) {
      throw new DomainError(
        channel.isPrivate ? ErrorCode.CHANNEL_NOT_VISIBLE : ErrorCode.FORBIDDEN,
        'insufficient permission',
      );
    }
  }

  /**
   * S15 (FR-CH-08): 호출자가 채널에서 특정 권한 비트를 가지는지 boolean 으로
   * 반환한다(throw 없이). 슬로우모드 BYPASS_SLOWMODE 면제 판정에 사용한다.
   */
  async hasPermission(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
    required: Permission,
  ): Promise<boolean> {
    const effective = await this.resolveEffective(channel, userId);
    return (effective & required) === required;
  }

  /** Shortcut for the visibility check that the URL-path guard runs. */
  async requireVisibility(
    channel: { id: string; workspaceId: string | null; isPrivate: boolean },
    userId: string,
  ): Promise<void> {
    if (!channel.isPrivate) return;
    await this.requirePermission(channel, userId, Permission.READ);
  }

  /**
   * S13 (FR-CH-19): ANNOUNCEMENT 채널 게시 게이트.
   *
   * 비-ANNOUNCEMENT 채널은 통과(no-op). ANNOUNCEMENT 채널은 게시 권한
   * (WRITE_MESSAGE 비트)을 가진 역할만 게시할 수 있다 — OWNER/ADMIN 은
   * ROLE_BASELINE 에 WRITE_MESSAGE 가 있으므로 통과하고, MEMBER 는 기본적으로
   * (ROLE_BASELINE 에는 WRITE_MESSAGE 가 있지만) 공지 채널에 한해 차단된다.
   *
   * 차단 예외: 채널에 명시적 ALLOW(WRITE_MESSAGE) 오버라이드(USER 또는 ROLE
   * 프린시펄)가 있으면 "허용 역할/사용자" 로 보고 통과시킨다 — "OWNER/ADMIN/
   * 허용역할만 게시" 요구의 '허용역할' 경로. resolveEffective 가 비트를
   * 계산하지만, MEMBER 기본 WRITE_MESSAGE 억제는 ANNOUNCEMENT 에 한정하므로
   * 여기서 타입별로 분기한다(전역 ROLE_BASELINE 은 건드리지 않는다 — TEXT
   * 채널 회귀 방지).
   *
   * 권한 부족 시 CHANNEL_POSTING_RESTRICTED(403) 를 던진다 — 일반 FORBIDDEN
   * 과 구분해 클라이언트가 "공지 채널 게시 제한" UI 로 분기할 수 있게 한다.
   */
  async requireAnnouncementPostingAllowed(
    // S62 (FR-RM03): 커스텀 Role UUID override 조회를 위해 workspaceId 를 받는다.
    channel: { id: string; type: string; workspaceId: string | null },
    userId: string,
    // S61: 5단계 확장. OWNER/ADMIN 만 무조건 게시 허용이고 MODERATOR/MEMBER/GUEST
    // 는 채널 명시 ALLOW override 가 있어야 게시할 수 있다(기존 MEMBER 동작 유지).
    role: WorkspaceRole,
  ): Promise<void> {
    if (channel.type !== 'ANNOUNCEMENT') return;
    // OWNER/ADMIN 은 항상 게시 가능.
    // S62 (MED-2): MODERATOR 는 게시 자동 허용하지 않는다 — PRD 정합상 ANNOUNCEMENT
    // 게시는 OWNER/ADMIN 무조건 + (그 외 역할은 명시 ALLOW override). MODERATOR 는
    // 채널 ALLOW override 가 있어야 게시할 수 있다(아래 override 검사로 처리).
    if (role === 'OWNER' || role === 'ADMIN') return;
    // 그 외(MODERATOR/MEMBER/GUEST): 채널에 명시적 ALLOW(WRITE_MESSAGE) 오버라이드
    // (USER, 시스템 역할 리터럴 ROLE, 또는 커스텀 Role UUID)가 있어야 게시 허용.
    // ANNOUNCEMENT 채널은 워크스페이스 채널이라 workspaceId 는 non-null 이지만, 타입상
    // null 가능성을 닫는다(DM 은 ANNOUNCEMENT 가 될 수 없어 위에서 이미 return).
    const roleUuids =
      channel.workspaceId === null ? [] : await this.memberRoleUuids(channel.workspaceId, userId);
    const overrides = await this.prisma.channelPermissionOverride.findMany({
      where: {
        channelId: channel.id,
        OR: [
          { principalType: 'USER', principalId: userId },
          { principalType: 'ROLE', principalId: { in: [role as string, ...roleUuids] } },
        ],
      },
      select: { allowMask: true, denyMask: true },
    });
    let allow = 0;
    let deny = 0;
    for (const o of overrides) {
      // S61: BigInt → number(집행 0xFF 도메인).
      allow |= Number(o.allowMask);
      deny |= Number(o.denyMask);
    }
    const effective = (allow & ~deny) >>> 0;
    if ((effective & Permission.WRITE_MESSAGE) !== Permission.WRITE_MESSAGE) {
      throw new DomainError(
        ErrorCode.CHANNEL_POSTING_RESTRICTED,
        'this announcement channel only allows admins / granted roles to post',
      );
    }
  }

  /**
   * S44 (FR-MN-02 / FR-MN-16 / ADR-4): 채널에서 호출자가 `@everyone`/`@here`/
   * `@channel` 멘션 fanout 권한(`MENTION_EVERYONE`, 카탈로그 비트 0x0080)을
   * 가지는지 boolean 으로 판정한다.
   *
   * S40 FR-RE07 fix-forward 와 동일한 ADR-4 5단계 fold:
   *   base → roleAllow → roleDeny → userAllow → userDeny
   * base 는 역할 기본값(OWNER/ADMIN on, MEMBER off)이고, 채널 override 의
   * allow/deny 마스크에서 MENTION_EVERYONE 비트만 추출해 누적한다. 따라서
   * MEMBER 도 override allow 면 권한을 얻고, OWNER/ADMIN 도 override deny 면
   * 권한을 잃는다(개인 DENY 가 역할 ALLOW 를 이긴다).
   *
   * DM 채널(workspaceId=null)은 워크스페이스 멤버/역할 개념이 없어 항상 false 다
   * — `@everyone` 자체가 무의미하고 extractMentions 도 false 를 반환한다.
   *
   * ⚠️ 비트 재사용 주석(S44 fix-forward · D12 carryover): 카탈로그 MENTION_EVERYONE
   * 은 0x0080 이고, 집행 enum(auth/permissions.ts)의 0x0080 은 PIN_MESSAGE 다(동일
   * 비트 위치 공유). 그러나 **PIN_MESSAGE 는 집행 경로 어디서도 hasPermission/require
   * 로 검사되지 않는 dead bit** 이며(pin/unpin 은 OWNER/ADMIN 역할 검사로만 게이트),
   * 따라서 MENTION_EVERYONE 의 0x0080 재사용은 안전하다(S40 MANAGE_CHANNEL 선례 동일).
   * 카탈로그 MENTION_EVERYONE 비트의 PIN_MESSAGE enum 분리는 D12 수렴 시 처리한다.
   */
  async resolveMentionEveryone(
    channel: { id: string; workspaceId: string | null },
    userId: string,
    role: WorkspaceRole,
  ): Promise<boolean> {
    if (channel.workspaceId === null) return false;
    // S62 (MED-3 / FR-RM03): 커스텀 Role UUID override 도 ROLE tier 로 반영한다.
    const roleUuids = await this.memberRoleUuids(channel.workspaceId, userId);
    const rolePrincipalIds = new Set<string>([role as string, ...roleUuids]);
    const overrides = await this.prisma.channelPermissionOverride.findMany({
      where: {
        channelId: channel.id,
        OR: [
          { principalType: 'USER', principalId: userId },
          { principalType: 'ROLE', principalId: { in: [role as string, ...roleUuids] } },
        ],
      },
      select: { principalType: true, principalId: true, allowMask: true, denyMask: true },
    });
    let roleAllow = 0;
    let roleDeny = 0;
    let userAllow = 0;
    let userDeny = 0;
    for (const o of overrides) {
      // S61: BigInt → number(집행 0xFF 도메인 · MENTION_EVERYONE 비트 0x80 포함).
      if (o.principalType === 'USER' && o.principalId === userId) {
        userAllow |= Number(o.allowMask);
        userDeny |= Number(o.denyMask);
      } else if (o.principalType === 'ROLE' && rolePrincipalIds.has(o.principalId)) {
        // 시스템 역할 리터럴 + 커스텀 Role UUID override 를 같은 ROLE tier 로 OR.
        roleAllow |= Number(o.allowMask);
        roleDeny |= Number(o.denyMask);
      }
    }
    // ADR-4 5단계 fold — MENTION_EVERYONE 비트만 누적(다른 비트는 무관).
    let mask = MENTION_EVERYONE_ROLE_BASE[role] ?? 0;
    mask |= roleAllow & MENTION_EVERYONE_BIT;
    mask &= ~(roleDeny & MENTION_EVERYONE_BIT);
    mask |= userAllow & MENTION_EVERYONE_BIT;
    mask &= ~(userDeny & MENTION_EVERYONE_BIT);
    return (mask & MENTION_EVERYONE_BIT) === MENTION_EVERYONE_BIT;
  }

  /**
   * S62 (FR-RM03): 멤버가 보유한 Role.id(UUID) 목록을 반환한다. ROLE override
   * 조회에서 시스템 역할 리터럴(레거시 principalId) 외에 커스텀 Role UUID
   * principalId 도 함께 매칭하기 위함이다. 멤버가 아니거나 역할이 없으면 빈 배열.
   */
  private async memberRoleUuids(workspaceId: string, userId: string): Promise<string[]> {
    const rows = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId },
      select: { roleId: true },
    });
    return rows.map((r) => r.roleId);
  }
}
