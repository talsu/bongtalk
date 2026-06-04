import { Injectable } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import {
  CreateInviteRequest,
  ROLE_RANK,
  type WorkspaceRole as SharedWorkspaceRole,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OutboxService } from '../../common/outbox/outbox.service';
import {
  INVITE_ACCEPTED,
  INVITE_CREATED,
  INVITE_DELETED,
  INVITE_REVOKED,
  MEMBER_JOINED,
} from '../events/workspace-events';
// S61 fix-forward (security A-2): 초대 수락 가입 시 시스템 MemberRole 동기.
import { syncMemberSystemRole } from '../roles/system-role-seed';
// S63 (FR-RM06): 초대 수락 시 차단된 userId 재가입 거부.
import { ModerationService } from '../moderation/moderation.service';
// S72 (D13 / FR-W22): 초대 수락 IP soft-block(차단 IP INVITE 수락 허용+audit) + 가입 ipHash 기록.
import { IpSoftBlockService } from '../moderation/ip-soft-block.service';
// S67 fix-forward (security MEDIUM + reviewer #5): hard delete 파괴적 액션 감사 기록.
import { AuditService, AuditAction } from '../../common/audit/audit.service';
// S66 (D13 / FR-W05a): 초대 수락 시점 emailVerified + emailDomains 진입 게이트.
import { assertWorkspaceEntryAllowed } from '../workspace-entry-gate';

// S67 (D13 / FR-W02 · Fork B): 신규 초대 코드는 8자 alphanumeric 으로 발급한다.
// 혼동 문자(0/O/1/l/I)를 제외한 커스텀 알파벳(57자)을 쓰며, 편향 없는 균등 추출을
// 위해 crypto.randomInt(상한 미만 균등) 로 매 자리를 뽑는다(Math.random 금지).
// 길이 8 · 알파벳 57 → 엔트로피 ≈ 8·log2(57) ≈ 46.7bit. 코드 자체의 엔트로피로
// brute-force 를 막기보다, 초대 preview/accept 의 per-IP·per-code·per-user
// rate-limit(invites.controller·rate-limit.service)이 enumeration 의 1차 방어선이며
// code 는 @unique 라 충돌 시 재시도한다. 기존 22자 base64url 코드는 길이 불문 @unique
// 로 그대로 동작한다(신규만 8자 — 기존 보존).
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const INVITE_CODE_LENGTH = 8;

function makeCode(): string {
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return out;
}

// S67 (D13 / FR-W17): 관리 목록 표시용 파생값(잔여 사용 횟수 + 활성 여부). 서버가
// 한 곳에서 계산해 FE 가 재계산하지 않게 한다.
function usesRemainingOf(maxUses: number | null, usedCount: number): number | null {
  return maxUses === null ? null : Math.max(0, maxUses - usedCount);
}

function isActiveInvite(
  invite: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    maxUses: number | null;
    usedCount: number;
  },
  now: Date,
): boolean {
  if (invite.revokedAt) return false;
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return false;
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return false;
  return true;
}

// S67 fix-forward (reviewer #3): accept() 의 멤버 INSERT 가 던진 P2002 가 WorkspaceMember
// 복합 PK(workspaceId+userId — 동일 사용자 동시 수락 패자) 충돌인지 판별한다. Prisma 의
// meta.target 은 Postgres 에서 보통 제약 이름 문자열("WorkspaceMember_pkey")이지만 일부
// 버전/경로에선 필드명 배열(["workspaceId","userId"])로 온다 — 둘 다 안전하게 매칭한다.
// 다른 unique 제약(향후 추가분·syncMemberSystemRole 내부 제약) 충돌이면 false → 호출부가
// rethrow 해 좌석 오환불·실패 은폐를 막는다.
function isWorkspaceMemberPkConflict(e: Prisma.PrismaClientKnownRequestError): boolean {
  const target = e.meta?.target;
  if (typeof target === 'string') {
    return target.includes('WorkspaceMember') && target.includes('pkey');
  }
  if (Array.isArray(target)) {
    const fields = target.map((t) => String(t));
    return fields.includes('workspaceId') && fields.includes('userId');
  }
  return false;
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    // S63 (FR-RM06): 차단된 userId 의 초대 수락 재가입을 거부하기 위한 차단 조회.
    private readonly moderation: ModerationService,
    // S67 fix-forward (security MEDIUM + reviewer #5): hard delete 감사 기록(파괴적 액션).
    private readonly audit: AuditService,
    // S72 (D13 / FR-W22): 초대 수락 IP soft-block + 가입 ipHash 기록.
    private readonly ipSoftBlock: IpSoftBlockService,
  ) {}

  async create(workspaceId: string, createdById: string, input: CreateInviteRequest) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const invite = await tx.invite.create({
            data: {
              id: randomUUID(),
              workspaceId,
              code: makeCode(),
              createdById,
              expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
              maxUses: input.maxUses ?? null,
              // S67 (D13 / FR-W02): 임시 멤버십 초대 플래그.
              temporary: input.temporary ?? false,
            },
          });
          await this.outbox.record(tx, {
            aggregateType: 'invite',
            aggregateId: invite.id,
            eventType: INVITE_CREATED,
            payload: { workspaceId, inviteId: invite.id, actorId: createdById },
          });
          return invite;
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          attempt < 2
        ) {
          continue;
        }
        throw e;
      }
    }
    throw new Error('unreachable — collision retry exhausted');
  }

  /**
   * S67 (D13 / FR-W17): 초대 관리 목록.
   * - ADMIN 이상(OWNER/ADMIN): 워크스페이스 전체 초대.
   * - MODERATOR: 자신이 생성한 초대만(createdById = actorId).
   * 비활성(취소/만료/소진)도 함께 반환해 FE 가 활성/비활성 구분을 표시한다.
   * usesRemaining/active/createdBy 파생 필드를 서버가 계산해 내려보낸다.
   */
  async list(workspaceId: string, actorId: string, actorRole: SharedWorkspaceRole) {
    const where: Prisma.InviteWhereInput = { workspaceId };
    // MODERATOR 는 본인 생성분만. ADMIN/OWNER 는 전체.
    if (ROLE_RANK[actorRole] < ROLE_RANK.ADMIN) {
      where.createdById = actorId;
    }
    const rows = await this.prisma.invite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, username: true } } },
    });
    const now = new Date();
    return rows.map((r) => ({
      ...r,
      usesRemaining: usesRemainingOf(r.maxUses, r.usedCount),
      active: isActiveInvite(r, now),
    }));
  }

  /**
   * S67 (D13 / FR-W17): 비활성화(soft revoke). revokedAt 을 찍는다.
   * MODERATOR 는 본인 생성분만 취소 가능(타인 링크는 INVITE_NOT_FOUND 로 비노출).
   */
  async revoke(
    workspaceId: string,
    inviteId: string,
    actorId: string,
    actorRole: SharedWorkspaceRole,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const where: Prisma.InviteWhereInput = { id: inviteId, workspaceId, revokedAt: null };
      // MODERATOR 는 본인 생성분만 — 타인 링크는 매칭에서 제외돼 INVITE_NOT_FOUND(403 대신
      // 404, 타인 링크 존재 사실을 누출하지 않음).
      if (ROLE_RANK[actorRole] < ROLE_RANK.ADMIN) {
        where.createdById = actorId;
      }
      const result = await tx.invite.updateMany({
        where,
        data: { revokedAt: new Date() },
      });
      if (result.count === 0) {
        throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
      }
      await this.outbox.record(tx, {
        aggregateType: 'invite',
        aggregateId: inviteId,
        eventType: INVITE_REVOKED,
        payload: { workspaceId, inviteId, actorId },
      });
    });
  }

  /**
   * S67 (D13 / FR-W17 · Fork C-2): 영구 삭제(hard delete). soft revoke(revokedAt)와
   * 구분되는 별도 경로다 — 행 자체를 제거한다(이미 취소된 초대도 정리 가능). 권한은
   * create/revoke 와 동일(ADMIN 전체 · MODERATOR 본인 생성분). MODERATOR 의 타인 링크는
   * 매칭에서 제외돼 INVITE_NOT_FOUND.
   */
  async hardDelete(
    workspaceId: string,
    inviteId: string,
    actorId: string,
    actorRole: SharedWorkspaceRole,
  ) {
    const where: Prisma.InviteWhereInput = { id: inviteId, workspaceId };
    if (ROLE_RANK[actorRole] < ROLE_RANK.ADMIN) {
      where.createdById = actorId;
    }
    // S67 fix-forward (security MEDIUM + reviewer #5): 파괴적 hard delete 를 $transaction
    // 으로 감싸 행 삭제 + outbox(INVITE_DELETED) + 감사 로그(AuditAction.INVITE_DELETED)를
    // 하나의 commit 으로 묶는다. soft revoke 가 INVITE_REVOKED outbox 를 남기는 것과 대칭이며,
    // rogue admin 의 무단 영구 삭제를 추적할 수 있게 한다. 삭제 *전* 행을 읽어 code 를
    // 확보한 뒤 같은 tx 에서 제거한다(권한 필터는 where 로 강제 — MODERATOR 타인 링크는
    // 매칭 0건 → INVITE_NOT_FOUND).
    await this.prisma.$transaction(async (tx) => {
      const target = await tx.invite.findFirst({ where, select: { id: true, code: true } });
      if (!target) {
        throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
      }
      await tx.invite.delete({ where: { id: target.id } });
      await this.outbox.record(tx, {
        aggregateType: 'invite',
        aggregateId: target.id,
        eventType: INVITE_DELETED,
        payload: { workspaceId, inviteId: target.id, actorId },
      });
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: AuditAction.INVITE_DELETED,
          targetId: target.id,
          details: { code: target.code },
        },
        tx,
      );
    });
  }

  /** Public preview — no auth. Hides workspace details beyond what a joiner needs.
   *  Callers (controller) must apply a per-IP rate limit before invoking this. */
  async preview(code: string) {
    const invite = await this.prisma.invite.findUnique({
      where: { code },
      include: {
        workspace: { select: { name: true, slug: true, iconUrl: true, deletedAt: true } },
      },
    });
    if (!invite || invite.workspace.deletedAt) {
      throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
    }
    // S66 fix-forward (FR-W21 / task-032): 취소된 초대는 generic INVITE_NOT_FOUND(404)
    // 가 아니라 INVITE_REVOKED(410) 로 구분한다 — preview 가 FR-W21 만료/취소 전용 화면
    // (EXPIRED_INVITE_CODES = {EXPIRED, EXHAUSTED, REVOKED})으로 분기하려면 취소 사유가
    // 노출돼야 한다. expired/exhausted 가 이미 410 이므로 열거 중립성 손실은 없다(선존
    // 비대칭 시정).
    if (invite.revokedAt) {
      throw new DomainError(ErrorCode.INVITE_REVOKED, 'invite revoked');
    }
    if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(ErrorCode.INVITE_EXPIRED, 'invite expired');
    }
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      throw new DomainError(ErrorCode.INVITE_EXHAUSTED, 'invite fully used');
    }
    return {
      workspace: {
        name: invite.workspace.name,
        slug: invite.workspace.slug,
        iconUrl: invite.workspace.iconUrl,
      },
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      usesRemaining:
        invite.maxUses !== null ? Math.max(0, invite.maxUses - invite.usedCount) : null,
    };
  }

  /**
   * Race-safe accept — atomic CAS on `usedCount` followed by member insert.
   * A concurrent-accept loser (two tabs from the same user) refunds the seat
   * it just consumed and surfaces ALREADY_MEMBER instead of a raw 500.
   */
  async accept(
    code: string,
    userId: string,
    // S66 (D13 / FR-W05a): 초대 수락 시점 진입 게이트(emailVerified + emailDomains).
    // 컨트롤러가 JWT 에서 로드한 본인 emailVerified/email 을 넘긴다. 게이트는 워크스페이스
    // emailDomains 와 함께 invite 조회 직후·CAS 전에 적용한다(미인증/도메인 불일치 사용자가
    // 초대 좌석을 소모하지 않게 함).
    // S72 (D13 / FR-W22): clientIp(req.ip 계열)로 IP soft-block 대조 + 가입 ipHash 기록.
    actor: { emailVerified: boolean; userEmail: string; clientIp?: string | null },
  ) {
    const existing = await this.prisma.invite.findUnique({
      where: { code },
      select: {
        id: true,
        workspaceId: true,
        revokedAt: true,
        expiresAt: true,
        maxUses: true,
        // S69 (D13 / FR-W10): 링크 초대 수락 시 WorkspaceMember.invitedById = 초대 생성자.
        createdById: true,
        // S67 (D13 / FR-W03): temporary=true 링크 수락 시 WorkspaceMember.isTemporary 기록.
        temporary: true,
        // S66 (D13 / FR-W05a): 도메인 게이트용 화이트리스트.
        // S67 fix-forward (perf #2): 응답에 필요한 워크스페이스 컬럼을 여기서 함께 selct 해
        // already-member·P2002·정상 가입 3개 분기의 workspace.findUnique 재조회(중복 쿼리)를
        // 없앤다. WorkspaceSchema 응답 shape 와 일치하도록 전 scalar 컬럼을 포함한다.
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            iconUrl: true,
            ownerId: true,
            visibility: true,
            category: true,
            joinMode: true,
            emailDomains: true,
            defaultChannelId: true,
            createdAt: true,
            deletedAt: true,
            deleteAt: true,
          },
        },
      },
    });
    if (!existing) {
      throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
    }
    // S66 fix-forward (FR-W21 / task-032): 취소 초대는 INVITE_REVOKED(410) 로 구분한다
    // (expired 처리와 일관·preview 와 대칭). pre-CAS 단계에서 즉시 취소가 보이는 경우이며,
    // findUnique↔CAS 사이 취소 레이스는 아래 post-CAS 재조회가 동일 코드로 처리한다.
    if (existing.revokedAt) {
      throw new DomainError(ErrorCode.INVITE_REVOKED, 'invite revoked');
    }
    if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(ErrorCode.INVITE_EXPIRED, 'invite expired');
    }

    const already = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: existing.workspaceId, userId } },
    });
    if (already) {
      // S67 (D13 / FR-W03): 이미 멤버인 사용자의 재수락은 throw(409) 대신 멱등 성공으로
      // 처리한다 — 초대 링크를 다시 눌러도 워크스페이스로 자연스럽게 이동하게 한다. 좌석
      // 소모(CAS) 전이므로 usedCount 도 건드리지 않는다. alreadyMember=true 로 신규 가입과
      // 구분해 FE 가 안내 문구를 분기한다.
      // S67 fix-forward (perf #2): pre-CAS findUnique 에서 함께 읽은 existing.workspace 재사용.
      return { workspace: existing.workspace, alreadyMember: true };
    }

    // S63 (FR-RM06): 차단된 userId 는 초대를 받아도 재진입할 수 없다. CAS(usedCount
    // 증가) 전에 검사해 차단 사용자가 초대 좌석을 소모하지 않게 한다(404 — 차단 사실을
    // 누출하지 않도록 초대 미존재와 동일한 중립 코드로 거부).
    if (await this.moderation.isBanned(existing.workspaceId, userId)) {
      throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite not found');
    }

    // S66 (D13 / FR-W05a): emailVerified 재확인 직후 emailDomains exact-match 검증.
    // emailDomains 빈 배열이면 도메인 게이트 통과(제한 없음).
    // S66 fix-forward (review m4): 진입 게이트를 already-member·ban 검사 *뒤*로 옮겨
    // joinPublic 과 순서를 통일한다 — 이미 멤버이거나 차단된 사용자는 게이트 평가 전에
    // 각자의 정확한 에러(ALREADY_MEMBER / 중립 404)를 받는다(멤버는 게이트 면제 의미 명확화).
    assertWorkspaceEntryAllowed({
      emailVerified: actor.emailVerified,
      userEmail: actor.userEmail,
      emailDomains: existing.workspace.emailDomains,
    });

    // S72 (D13 / FR-W22): IP soft-block. 초대 수락은 INVITE 메커니즘이라 차단 IP 매칭이어도
    // hard-block 하지 않고(NAT 오탐 방지) 허용하되 SUSPICIOUS_JOIN 감사를 남긴다. CAS(좌석
    // 소모) 전에 두어 ipHash 를 확보하고, 멤버 행에 기록해 추후 ban 시 IP 가 복사되게 한다.
    const { ipHash } = await this.ipSoftBlock.assertNotIpBlocked({
      workspaceId: existing.workspaceId,
      userId,
      clientIp: actor.clientIp,
      mechanism: 'INVITE',
    });

    const now = new Date();
    // Compare-and-swap is intentionally OUTSIDE the transaction so that the
    // atomic UPDATE commits as a single statement and visible races between
    // concurrent requests are resolved by row-level locking.
    const casResult = await this.prisma.$executeRawUnsafe<number>(
      `UPDATE "Invite"
         SET "usedCount" = "usedCount" + 1
       WHERE code = $1
         AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR "expiresAt" > $2)
         AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`,
      code,
      now,
    );
    if (casResult === 0) {
      // Task-013-A (task-032 closure): the pre-CAS findUnique catches
      // NOT_FOUND + REVOKED + EXPIRED; the CAS itself catches
      // EXHAUSTED + any race where the invite was revoked between the
      // findUnique and the UPDATE. A second findUnique tells the two
      // apart so we surface a precise error instead of always
      // INVITE_EXHAUSTED.
      const post = await this.prisma.invite.findUnique({
        where: { code },
        select: { revokedAt: true, expiresAt: true, maxUses: true, usedCount: true },
      });
      if (!post) {
        throw new DomainError(ErrorCode.INVITE_NOT_FOUND, 'invite vanished mid-accept');
      }
      if (post.revokedAt) {
        throw new DomainError(ErrorCode.INVITE_REVOKED, 'invite was revoked');
      }
      if (post.expiresAt && post.expiresAt.getTime() <= Date.now()) {
        throw new DomainError(ErrorCode.INVITE_EXPIRED, 'invite expired');
      }
      // Fell through → exhausted is the remaining case.
      throw new DomainError(ErrorCode.INVITE_EXHAUSTED, 'invite fully used');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.workspaceMember.create({
          data: {
            workspaceId: existing.workspaceId,
            userId,
            role: WorkspaceRole.MEMBER,
            // S67 (D13 / FR-W03): temporary=true 초대로 가입한 멤버는 임시로 기록한다
            // (S70 의 연결 종료 강퇴 배치 대상). 영구 초대(false)면 영구 멤버.
            isTemporary: existing.temporary,
            // S69 (D13 / FR-W10): 링크 초대 수락 → 초대자는 링크 생성자.
            invitedById: existing.createdById,
            // S72 (D13 / FR-W22): 가입 시점 요청 IP 해시(추후 ban 시 BannedMember 로 복사).
            ipHash,
          },
        });
        // S61 fix-forward (security A-2 · MemberRole desync): 가입 트랜잭션에서 MEMBER
        // 시스템 MemberRole 을 시드한다(enum ↔ 시스템 Role 동기 불변식). 누락 시
        // ADMIN 승격 후에도 역할 생성/부여가 전부 거부된다.
        await syncMemberSystemRole(tx, existing.workspaceId, userId, 'MEMBER');
        await this.outbox.record(tx, {
          aggregateType: 'member',
          aggregateId: userId,
          eventType: MEMBER_JOINED,
          payload: { workspaceId: existing.workspaceId, userId, actorId: userId },
        });
        await this.outbox.record(tx, {
          aggregateType: 'invite',
          aggregateId: existing.id,
          eventType: INVITE_ACCEPTED,
          payload: {
            workspaceId: existing.workspaceId,
            inviteId: existing.id,
            actorId: userId,
          },
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        // S67 fix-forward (reviewer #3): P2002 가 WorkspaceMember 복합 PK(=동일 사용자
        // 동시 수락 패자) 충돌일 때만 좌석 환불 + 멱등 성공으로 처리한다. 다른 unique 제약
        // (예: syncMemberSystemRole 의 MemberRole, 향후 추가 제약) 충돌을 alreadyMember 로
        // 오탐하면 좌석을 잘못 환불하고 실패를 성공으로 숨긴다. meta.target 이 멤버 복합 PK
        // (workspaceId+userId) 를 가리키는지 확인하고, 아니면 rethrow 한다.
        isWorkspaceMemberPkConflict(e)
      ) {
        // 동일 사용자의 동시 수락(두 탭) 패자: 방금 소모한 좌석을 환불하고, 이미 멤버가
        // 되었으므로 멱등 성공으로 처리한다(S67 — throw 대신 alreadyMember=true).
        await this.prisma.$executeRawUnsafe(
          `UPDATE "Invite" SET "usedCount" = "usedCount" - 1 WHERE code = $1 AND "usedCount" > 0`,
          code,
        );
        // S67 fix-forward (perf #2): pre-CAS findUnique 에서 함께 읽은 existing.workspace 재사용.
        return { workspace: existing.workspace, alreadyMember: true };
      }
      throw e;
    }

    // S67 (D13 / FR-W03): 신규 가입 — alreadyMember=false.
    // S67 fix-forward (perf #2): pre-CAS findUnique 에서 함께 읽은 existing.workspace 재사용.
    return { workspace: existing.workspace, alreadyMember: false };
  }
}
