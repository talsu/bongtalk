import { Injectable } from '@nestjs/common';
import { ChannelType, Prisma, WorkspaceJoinMode, WorkspaceRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  CreateWorkspaceRequest,
  type DiscoveryPage as DiscoverPage,
  type DiscoveryWorkspace,
  RESERVED_SLUGS,
  ROLE_RANK,
  UpdateWorkspaceRequest,
  WorkspaceRole as SharedWorkspaceRole,
  // 072 백로그 S-C (FR-W01): 워크스페이스 아이콘 업로드 정책 상수.
  WS_ICON_ALLOWED_MIME,
  WS_ICON_MAX_BYTES,
  type WsIconMime,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
// 072 백로그 S-C (FR-W01): 워크스페이스 아이콘 업로드(presigned POST + finalize magic).
import { S3Service, sanitizeFilename } from '../storage/s3.service';
import { matchesMagic, type MagicSupportedMime } from '../storage/validate-magic-bytes';
import {
  OWNERSHIP_TRANSFERRED,
  WORKSPACE_CREATED,
  WORKSPACE_DELETED,
  WORKSPACE_RESTORED,
} from './events/workspace-events';
// S61 (D12 / FR-RM01): 워크스페이스 생성 시 시스템 5역할 + OWNER MemberRole 시드.
// syncMemberSystemRole 은 소유권 이전/가입 시 시스템 MemberRole 동기(A-1/A-2)에 쓴다.
import {
  seedSystemRoles,
  seedMemberSystemRole,
  syncMemberSystemRole,
} from './roles/system-role-seed';
// S62 fix-forward (security A-1): 소유권 이양 직후 from/to 두 멤버의 권한 캐시 무효화.
import { MemberRoleService } from './roles/member-role.service';
// S63 fix-forward (security A-1 = HIGH/BLOCKER): PUBLIC 워크스페이스 즉시 가입(joinPublic)
// 에서도 차단(BannedMember) 여부를 검사해 ban 우회 재가입을 막는다(invites.accept 선례).
import { ModerationService } from './moderation/moderation.service';
// S72 (D13 / FR-W22): joinPublic 에 IP soft-block(차단 IP PUBLIC 가입 허용+audit) + 가입
// ipHash 기록을 적용한다.
import { IpSoftBlockService } from './moderation/ip-soft-block.service';
// S65 (D13 / FR-W13): 소유권 양도 시 OWNER 비밀번호 재확인. auth 와 동일한 argon2
// PasswordService 로 검증한다(저장된 passwordHash 가 argon2 — bcrypt.compare 는 불일치).
import { PasswordService } from '../auth/services/password.service';
// S65 (D13 / FR-W01): 생성 트랜잭션에서 #general 채널을 Prisma tx 로 직접 만들 때
// 첫 채널 position 으로 쓴다(ChannelsService 미import — 순환 회피, ★결정 B).
import { POSITION_STRIDE } from '../channels/positioning/fractional-position';
// S65 (D13 / FR-W01): #general 자동 생성 시에도 채널 생성 outbox 이벤트를 같은
// 트랜잭션에서 기록해 실시간 채널 목록이 갱신되도록 한다(문자열 상수 — 순환 없음).
import { CHANNEL_CREATED } from '../channels/events/channel-events';
// S66 (D13 / FR-W05a): PUBLIC 즉시 가입 시점 emailVerified + emailDomains 진입 게이트.
import { assertWorkspaceEntryAllowed } from './workspace-entry-gate';
// S72 (D13 / FR-W16): 디스커버리 검색 Redis 5분 캐시 + 버전 기반 invalidation.
import { DiscoverCacheService } from './discover-cache.service';

// 072 백로그 S-C (FR-W01): 워크스페이스 아이콘 MinIO 키 prefix(`ws-icons/<wsId>/<file>`),
// magic-byte 검사용 head 길이, presigned PUT/GET TTL. ws아바타(member-profile) 선례와
// 동일한 값을 쓴다(전역 아바타 정책 일관).
const WS_ICON_KEY_PREFIX = 'ws-icons';
const WS_ICON_MAGIC_HEAD = 15;
const WS_ICON_PRESIGN_TTL_SEC = Number(process.env.S3_PRESIGN_PUT_TTL_SEC ?? 900);
// presigned GET URL TTL(초). 프로필 이미지(전역 avatar/banner/ws아바타)와 동일한 600s 로
// 서명해 token-leak 표면을 줄인다. presignGet 은 순수 서명(네트워크 없음)이라 목록 read
// 경로에서 워크스페이스마다 호출해도 round-trip 이 없다.
const WS_ICON_GET_TTL_SEC = 600;

/**
 * Every state-change writes an OutboxEvent inside the same Prisma transaction
 * as the business row. The dispatcher picks it up after commit — so subscribers
 * never see pre-commit state, and a mid-request crash leaves no orphan event.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    // S62 fix-forward (security A-1 = MAJOR-1 / MEDIUM-2): 소유권 이양은 from/to 두
    // 멤버의 역할(OWNER↔ADMIN)을 바꾸므로 두 멤버의 채널별 권한 캐시를 모두 DEL 한다.
    private readonly memberRoles: MemberRoleService,
    // S63 fix-forward (security A-1): joinPublic 의 ban 우회 차단을 위한 차단 조회.
    private readonly moderation: ModerationService,
    // S65 (D13 / FR-W13): 소유권 양도 비밀번호 재확인용 argon2 검증기.
    private readonly passwords: PasswordService,
    // S72 (D13 / FR-W16): 디스커버리 검색 결과 캐시(read/write/invalidate).
    private readonly discoverCache: DiscoverCacheService,
    // S72 (D13 / FR-W22): joinPublic 의 IP soft-block + 가입 ipHash 기록. 생성자 끝에 두어
    // 기존 호출부(6-arg)의 인자 위치를 보존한다.
    private readonly ipSoftBlock: IpSoftBlockService,
    // 072 백로그 S-C (FR-W01): 워크스페이스 아이콘 presign/finalize/delete + 읽기 시
    // storageKey → presigned GET URL 변환. StorageModule 이 제공(이미 import 됨).
    private readonly s3: S3Service,
  ) {}

  private get graceMs(): number {
    return Number(process.env.WORKSPACE_SOFT_DELETE_GRACE_DAYS ?? 30) * 24 * 60 * 60 * 1000;
  }

  async create(
    userId: string,
    input: CreateWorkspaceRequest,
    // S66 fix-forward (review HIGH-3): 워크스페이스 생성도 emailVerified 게이트를
    // 적용한다. FE VerificationGate 가 /w/new 진입을 막지만 서버 대칭이 없으면 미인증
    // 사용자가 curl 로 워크스페이스를 만들고 OWNER 가 될 수 있다. 도메인 게이트
    // (emailDomains)는 생성에는 불필요하므로 emailVerified 만 확인한다(컨트롤러가
    // JWT 에서 로드한 본인 값을 넘긴다).
    actor: { emailVerified: boolean },
  ) {
    if (!actor.emailVerified) {
      throw new DomainError(
        ErrorCode.EMAIL_NOT_VERIFIED,
        '이메일 인증 후 워크스페이스를 만들 수 있습니다',
      );
    }
    if (RESERVED_SLUGS.has(input.slug)) {
      throw new DomainError(ErrorCode.WORKSPACE_SLUG_RESERVED, `slug "${input.slug}" is reserved`);
    }
    // S65 (D13 / FR-W01): 이메일 도메인 화이트리스트는 소문자로 정규화해 저장한다
    // (zod 가 형태를 강제하지만 입력 케이스를 안정화). 중복은 제거한다.
    const emailDomains = input.emailDomains
      ? [...new Set(input.emailDomains.map((d) => d.trim().toLowerCase()))]
      : [];
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // S65 (D13 / FR-W01): #general 채널 id 를 미리 만들어 Workspace.defaultChannelId
        // 와 동기한다(단일 트랜잭션). FK(Workspace.defaultChannelId → Channel)가 deferrable
        // 가 아니므로 채널을 먼저 만든 뒤 워크스페이스를 업데이트한다.
        const generalChannelId = randomUUID();
        const workspace = await tx.workspace.create({
          data: {
            id: randomUUID(),
            name: input.name,
            slug: input.slug,
            description: input.description ?? null,
            iconUrl: input.iconUrl ?? null,
            // task-030: visibility defaults to PRIVATE. When PUBLIC, the
            // shared-types schema has already enforced category +
            // description at the zod layer.
            visibility: input.visibility ?? 'PRIVATE',
            category: input.category ?? null,
            // S65 (D13 / FR-W01): joinMode 미지정 시 PRIVATE(초대 전용). visibility 와
            // 직교하므로 PUBLIC discover 노출과 가입 방식을 따로 둘 수 있다.
            joinMode: (input.joinMode ?? 'PRIVATE') as WorkspaceJoinMode,
            emailDomains,
            ownerId: userId,
            members: {
              create: { userId, role: WorkspaceRole.OWNER },
            },
          },
        });
        // S65 (D13 / FR-W01): #general 기본 채널을 같은 트랜잭션에서 생성한다(★결정 B —
        // ChannelsModule 미import·순환 회피, Prisma tx 직접). 워크스페이스 첫 채널이므로
        // position 은 POSITION_STRIDE. isDefault=true 로 시드하고 아래에서
        // Workspace.defaultChannelId 로 가리킨다.
        const general = await tx.channel.create({
          data: {
            id: generalChannelId,
            workspaceId: workspace.id,
            name: 'general',
            type: ChannelType.TEXT,
            position: POSITION_STRIDE,
            isDefault: true,
          },
        });
        const updatedWorkspace = await tx.workspace.update({
          where: { id: workspace.id },
          data: { defaultChannelId: general.id },
        });
        // S61 (FR-RM01): 시스템 5역할 시드 + 생성자(OWNER) MemberRole 연결.
        await seedSystemRoles(tx, workspace.id);
        await seedMemberSystemRole(tx, workspace.id, userId, 'OWNER');
        await this.outbox.record(tx, {
          aggregateType: 'workspace',
          aggregateId: workspace.id,
          eventType: WORKSPACE_CREATED,
          payload: { workspaceId: workspace.id, ownerId: userId, slug: workspace.slug },
        });
        // S65 (D13 / FR-W01): #general 생성도 channel.created 로 기록해 실시간 채널
        // 목록(WorkspaceNav/ChannelColumn)이 즉시 반영되게 한다(채널 생성 경로 선례).
        await this.outbox.record(tx, {
          aggregateType: 'channel',
          aggregateId: general.id,
          eventType: CHANNEL_CREATED,
          payload: {
            workspaceId: workspace.id,
            actorId: userId,
            channel: {
              id: general.id,
              workspaceId: workspace.id,
              name: general.name,
              type: general.type,
              isPrivate: general.isPrivate,
              isDefault: general.isDefault,
            },
          },
        });
        return updatedWorkspace;
      });
      // S72 W16 fix-forward (reviewer HIGH-2): PUBLIC 워크스페이스를 새로 만들면 discover
      // 결과에 즉시 나타나야 하므로 검색 캐시를 무효화한다(버전 bump → 다음 호출 MISS).
      // PRIVATE 은 discover 에 노출되지 않으므로 무효화하지 않는다(update/softDelete/
      // restore 의 invalidate 와 일관 — 노출 가능성이 있는 변경만 bump).
      if (created.visibility === 'PUBLIC') {
        await this.discoverCache.invalidate();
      }
      return created;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError(ErrorCode.WORKSPACE_SLUG_TAKEN, `slug "${input.slug}" is taken`);
      }
      throw e;
    }
  }

  async listMine(userId: string) {
    const rows = await this.prisma.workspace.findMany({
      where: {
        deletedAt: null,
        members: { some: { userId } },
      },
      orderBy: { createdAt: 'asc' },
    });
    // 072 백로그 S-C (FR-W01): iconUrl 은 MinIO storageKey 이므로 레일 렌더용 presigned
    // GET URL 로 변환한다. presignGet 은 순수 서명이라 워크스페이스마다 호출해도 round-trip
    // 이 없다(아래 presignIconUrl 참고).
    return Promise.all(
      rows.map(async (w) => ({ ...w, iconUrl: await this.presignIconUrl(w.iconUrl) })),
    );
  }

  async getWithMyRole(workspaceId: string, userId: string) {
    const [workspace, member] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId } }),
      this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
      }),
    ]);
    if (!workspace || !member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    // 072 백로그 S-C (FR-W01): 설정 페이지가 현재 아이콘을 표시하도록 presigned GET URL 로 변환.
    return {
      workspace: { ...workspace, iconUrl: await this.presignIconUrl(workspace.iconUrl) },
      myRole: member.role as SharedWorkspaceRole,
    };
  }

  /**
   * 072 백로그 S-C (FR-W01): 저장된 iconUrl 은 MinIO storageKey 다. 외부 노출 전 presigned
   * GET URL(600s)로 변환한다. null 이면 그대로 null(아이콘 미설정). 과거 PATCH 로 외부 절대
   * URL 이 들어갔을 가능성에 대비해 http(s) 로 시작하면 presign 없이 통과시킨다(혼재 데이터 방어).
   *
   * public — 같은 모듈의 InvitesService(초대 미리보기)도 동일 변환을 재사용한다(presign-on-read
   * 불변식을 워크스페이스 iconUrl 노출 표면 전체에서 일관 유지).
   */
  async presignIconUrl(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (key.startsWith('http://') || key.startsWith('https://')) return key;
    try {
      return await this.s3.presignGet(key, { expiresIn: WS_ICON_GET_TTL_SEC });
    } catch {
      return null;
    }
  }

  /**
   * 072 백로그 S-C 리뷰(LOW): discover 페이지의 각 항목 iconUrl(raw storageKey)을 presigned
   * GET URL 로 변환한다. 캐시에는 raw 키를 저장하므로 HIT/MISS 양쪽 반환 직전에 호출해
   * listMine/getWithMyRole 와 동일한 presign-on-read 불변식을 유지한다.
   */
  private async presignDiscoverPage(page: DiscoverPage): Promise<DiscoverPage> {
    const items = await Promise.all(
      page.items.map(async (it) => ({ ...it, iconUrl: await this.presignIconUrl(it.iconUrl) })),
    );
    return { ...page, items };
  }

  /**
   * 072 백로그 S-C (FR-W01): POST /workspaces/:id/icon/presign. MIME/크기 검증 후 단일 키
   * presigned POST 를 발급한다(MinIO 가 업로드 시점에 크기/Content-Type 강제). 매 업로드마다
   * 새 uuid 세그먼트를 써서 finalize 전까지 기존 아이콘에 영향을 주지 않는다(ws아바타
   * presignAvatar 패턴 동일). 서버 리사이즈 없음([[feedback_no_server_media_resize]]).
   */
  async presignIcon(
    workspaceId: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<{ key: string; url: string; fields: Record<string, string>; expiresAt: string }> {
    if (!(WS_ICON_ALLOWED_MIME as readonly string[]).includes(contentType)) {
      throw new DomainError(
        ErrorCode.INVALID_MIME,
        `mime not allowed: ${contentType} (png/jpeg/webp only)`,
      );
    }
    if (sizeBytes <= 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'sizeBytes must be positive');
    }
    if (sizeBytes > WS_ICON_MAX_BYTES) {
      throw new DomainError(
        ErrorCode.FILE_TOO_LARGE,
        `ws icon too large (${sizeBytes} > ${WS_ICON_MAX_BYTES})`,
      );
    }
    const ext = this.iconExtForMime(contentType as WsIconMime);
    const key = `${WS_ICON_KEY_PREFIX}/${workspaceId}/${randomUUID()}${sanitizeFilename(ext)}`;
    const { url, fields } = await this.s3.presignPost(
      key,
      contentType,
      WS_ICON_MAX_BYTES,
      WS_ICON_PRESIGN_TTL_SEC,
    );
    const expiresAt = new Date(Date.now() + WS_ICON_PRESIGN_TTL_SEC * 1000).toISOString();
    return { key, url, fields, expiresAt };
  }

  /**
   * PUT /workspaces/:id/icon. presign 키가 이 워크스페이스 prefix 인지 + 업로드 landed/크기/
   * 선언MIME/magic 을 검증한 뒤 Workspace.iconUrl 에 storageKey 를 저장한다. 이전 키(있고
   * 외부 URL 이 아니면)는 best-effort 삭제. discover 카드가 아이콘을 노출하므로 캐시를
   * 무효화하고 presigned GET URL 을 응답한다(ws아바타 finalizeAvatar 패턴 동일).
   */
  async finalizeIcon(workspaceId: string, key: string): Promise<{ iconUrl: string }> {
    const expectedPrefix = `${WS_ICON_KEY_PREFIX}/${workspaceId}/`;
    if (key.includes('..')) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'key contains a path traversal segment');
    }
    if (!key.startsWith(expectedPrefix)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'key does not belong to this workspace');
    }
    const head = await this.s3.headObject(key);
    if (!head) {
      throw new DomainError(ErrorCode.INVALID_FILE, 'ws icon upload never landed');
    }
    if (head.contentLength > WS_ICON_MAX_BYTES) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw new DomainError(
        ErrorCode.FILE_TOO_LARGE,
        `ws icon too large (${head.contentLength} > ${WS_ICON_MAX_BYTES})`,
      );
    }
    const declaredMime = head.contentType;
    if (!declaredMime || !(WS_ICON_ALLOWED_MIME as readonly string[]).includes(declaredMime)) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw new DomainError(ErrorCode.INVALID_MIME, `ws icon mime not allowed: ${declaredMime}`);
    }
    const headBytes = await this.s3.getObjectRange(key, WS_ICON_MAGIC_HEAD);
    if (!headBytes || !matchesMagic(headBytes, declaredMime as MagicSupportedMime)) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw new DomainError(
        ErrorCode.INVALID_MAGIC_BYTES,
        `declared ${declaredMime} but file magic does not match`,
      );
    }
    const prev = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { iconUrl: true },
    });
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { iconUrl: key } });
    // 이전 키 best-effort 정리(외부 절대 URL 레거시 값은 MinIO 객체가 아니므로 건너뛴다).
    if (prev?.iconUrl && prev.iconUrl !== key && !prev.iconUrl.startsWith('http')) {
      void this.s3.deleteObject(prev.iconUrl).catch(() => undefined);
    }
    await this.discoverCache.invalidate();
    const iconUrl = await this.s3.presignGet(key, { expiresIn: WS_ICON_GET_TTL_SEC });
    return { iconUrl };
  }

  /** DELETE /workspaces/:id/icon. iconUrl 을 null 로 리셋 + 객체 best-effort 삭제(멱등). */
  async deleteIcon(workspaceId: string): Promise<void> {
    const row = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { iconUrl: true },
    });
    if (!row?.iconUrl) return; // 이미 없음 — 멱등.
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { iconUrl: null } });
    if (!row.iconUrl.startsWith('http')) {
      await this.s3.deleteObject(row.iconUrl).catch(() => undefined);
    }
    await this.discoverCache.invalidate();
  }

  private iconExtForMime(mime: WsIconMime): string {
    switch (mime) {
      case 'image/png':
        return '.png';
      case 'image/jpeg':
        return '.jpg';
      case 'image/webp':
        return '.webp';
    }
  }

  async update(workspaceId: string, input: UpdateWorkspaceRequest, actorRole?: string) {
    // task-030 reviewer BLOCKER-1: visibility + category changes are OWNER
    // only. The PATCH route is shared with name/description (ADMIN-allowed),
    // so we enforce the OWNER gate at the service level when the incoming
    // patch touches visibility or category.
    // 072 백로그 S-C (FR-W01): joinMode(가입 모드) 변경도 visibility/category 와 동일하게
    // OWNER 전용이다 — 누가 워크스페이스에 들어올 수 있는지를 좌우하는 정책이므로 ADMIN 이
    // 임의로 바꿀 수 없게 막는다.
    if (
      (input.visibility !== undefined ||
        input.category !== undefined ||
        input.joinMode !== undefined) &&
      actorRole !== 'OWNER'
    ) {
      throw new DomainError(
        ErrorCode.WORKSPACE_INSUFFICIENT_ROLE,
        'only OWNER can change visibility, category, or join mode',
      );
    }
    // S68 (D13 / FR-W05 · Fork C): emailDomains 화이트리스트 변경은 OWNER 전용이다
    // (전용 엔드포인트 대신 이 공유 PATCH 로 확장 — 서비스 레이어 게이트, visibility/
    // category OWNER 게이트 선례 일관). 도메인 게이트는 워크스페이스 진입을 좌우하므로
    // ADMIN 이 임의로 넓히거나 좁힐 수 없게 OWNER 로 제한한다.
    if (input.emailDomains !== undefined && actorRole !== 'OWNER') {
      throw new DomainError(
        ErrorCode.WORKSPACE_EMAIL_DOMAINS_FORBIDDEN,
        'only OWNER can change email domain whitelist',
      );
    }
    // task-030: PUBLIC transition requires category + description to be
    // present on the merged state (either pre-existing or in this patch).
    if (input.visibility === 'PUBLIC') {
      const current = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { category: true, description: true },
      });
      const merged = {
        category: input.category !== undefined ? input.category : current?.category,
        description: input.description !== undefined ? input.description : current?.description,
      };
      // S65 fix-forward (D-2): 도메인 불변식 위반은 422(WORKSPACE_PUBLIC_REQUIRES_METADATA)로
      // 거부한다 — 요청 envelope 은 well-formed 이나 "공개 워크스페이스는 카테고리+설명
      // 필수"를 못 넘긴 처리 불가 상태다(종전 VALIDATION_FAILED 400 에서 정정).
      if (!merged.category) {
        throw new DomainError(
          ErrorCode.WORKSPACE_PUBLIC_REQUIRES_METADATA,
          'category is required when switching to PUBLIC',
        );
      }
      if (!merged.description || merged.description.trim().length === 0) {
        throw new DomainError(
          ErrorCode.WORKSPACE_PUBLIC_REQUIRES_METADATA,
          'description is required when switching to PUBLIC',
        );
      }
    }
    // S68 (D13 / FR-W05 · Fork C): emailDomains 는 생성 시 로직(create)과 동일하게 소문자
    // 정규화 + 중복 제거해 저장한다(빈 배열 = 제한 없음). undefined 면 변경 없음.
    const normalizedEmailDomains =
      input.emailDomains !== undefined
        ? [...new Set(input.emailDomains.map((d) => d.trim().toLowerCase()))]
        : undefined;
    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        // 072 백로그 S-C 리뷰(LOW): iconUrl 은 PATCH 에서 제거 — 전용 presign/finalize/delete
        // 엔드포인트가 storageKey 쓰기의 단일 출처다(dual-write/orphan 불일치 차단).
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        // 072 백로그 S-C (FR-W01): 가입 모드 편집. create() 와 동일한 WorkspaceJoinMode enum 캐스트.
        ...(input.joinMode !== undefined ? { joinMode: input.joinMode as WorkspaceJoinMode } : {}),
        ...(normalizedEmailDomains !== undefined ? { emailDomains: normalizedEmailDomains } : {}),
      },
    });
    // S72 (D13 / FR-W16): 디스커버리 노출 필드(name/description/visibility/category/joinMode)가
    // 바뀌면 검색 캐시를 무효화한다 — 버전 키 bump 로 전체 네임스페이스를 옮긴다(다음
    // discover 호출은 MISS). joinMode 는 072 백로그 S-C 에서 PATCH 로 편집 가능해졌고
    // discover 카드에 가입 모드가 노출되므로 무효화 조건에 포함한다. emailDomains 는
    // discover 출력에 영향 없어 무효화 대상에서 제외한다.
    if (
      input.name !== undefined ||
      input.description !== undefined ||
      input.visibility !== undefined ||
      input.category !== undefined ||
      input.joinMode !== undefined
    ) {
      await this.discoverCache.invalidate();
    }
    return updated;
  }

  /**
   * S55 (FR-AM-20): 워크스페이스 첨부 정책 조회. 설정 행이 없으면 기본값(상한 없음·
   * 추가 차단 없음)을 반환한다. maxFileSizeBytes 는 와이어상 number|null.
   */
  async getSetting(
    workspaceId: string,
  ): Promise<{ maxFileSizeBytes: number | null; blockedExtensions: string[] }> {
    const row = await this.prisma.workspaceSetting.findUnique({
      where: { workspaceId },
      select: { maxFileSizeBytes: true, blockedExtensions: true },
    });
    return {
      maxFileSizeBytes: row?.maxFileSizeBytes != null ? Number(row.maxFileSizeBytes) : null,
      blockedExtensions: row?.blockedExtensions ?? [],
    };
  }

  /**
   * S55 (FR-AM-20): 워크스페이스 첨부 정책 upsert(ADMIN 게이트는 컨트롤러). 미지정
   * 필드는 변경 없음. maxFileSizeBytes=null 은 상한 해제(전역 폴백). blockedExtensions
   * 는 통째 교체(빈 배열 = 추가 차단 없음). upsert 라 설정 행이 없으면 생성한다.
   */
  async updateSetting(
    workspaceId: string,
    input: { maxFileSizeBytes?: number | null; blockedExtensions?: string[] },
  ): Promise<{ maxFileSizeBytes: number | null; blockedExtensions: string[] }> {
    const maxBig =
      input.maxFileSizeBytes === undefined
        ? undefined
        : input.maxFileSizeBytes === null
          ? null
          : BigInt(input.maxFileSizeBytes);
    const blocked = input.blockedExtensions?.map((e) => e.toLowerCase());

    const row = await this.prisma.workspaceSetting.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        maxFileSizeBytes: maxBig ?? null,
        blockedExtensions: blocked ?? [],
      },
      update: {
        ...(maxBig !== undefined ? { maxFileSizeBytes: maxBig } : {}),
        ...(blocked !== undefined ? { blockedExtensions: blocked } : {}),
      },
      select: { maxFileSizeBytes: true, blockedExtensions: true },
    });
    return {
      maxFileSizeBytes: row.maxFileSizeBytes != null ? Number(row.maxFileSizeBytes) : null,
      blockedExtensions: row.blockedExtensions,
    };
  }

  /**
   * S72 (D13 / FR-W16): 디스커버리 검색. Redis 캐시를 앞에 둔다 — 같은
   * (category|q|cursor|limit) 조합은 버전 키 기반 캐시 키로 HIT 시 DB 를 건너뛴다.
   * 반환에 cacheStatus 를 실어 컨트롤러가 X-Cache 헤더로 echo 한다. 디스커버리 노출
   * 필드 변경(create PUBLIC / PATCH name·description·visibility·category / softDelete /
   * restore)은 버전 bump 로 전체 캐시를 무효화한다(stampede 는 TTL 로 수용).
   *
   * S72 W16 fix-forward (reviewer HIGH-1, memberCount/커서 stale): memberCount 변동(가입/
   * 승인/초대 수락 등 멤버 수만 바뀌는 이벤트)은 의도적으로 invalidate() 하지 않는다 —
   * 캐시된 memberCount 는 최대 TTL(DISCOVER_CACHE_TTL_SEC) 동안 stale 일 수 있다. 또한
   * 커서가 memberCount 기반(`{memberCount}|{id}`)이라, 동일 캐시 윈도우 안에서 멤버 수가
   * 바뀌면 페이지 경계 정합(누락/중복)도 같은 TTL 동안 stale 일 수 있다. TTL 을 60s 로
   * 짧게 둬 stale 창을 좁힌다(discover-cache.service.ts 참조). 멤버 수의 분 단위 지연은
   * discover UX 상 수용 가능하다.
   *
   * S72 W16 fix-forward (security MEDIUM): q/cursor 길이를 진입에서 클램프한다 — q 최대
   * 200자(Redis 키 폭발 + ILIKE DoS 방지), cursor 최대 128자(`{memberCount}|{uuid}` 는
   * ~50자라 넉넉한 상한). 초과 입력은 잘라 정상 경로로 처리한다(거부 대신 절단 —
   * cursor 가 잘리면 파싱이 자연스럽게 실패해 첫 페이지로 폴백).
   */
  async discover(opts: {
    category?: string;
    q?: string;
    cursor: string | null;
    limit: number;
  }): Promise<{ payload: DiscoverPage; cacheStatus: 'HIT' | 'MISS' }> {
    // S72 W16 fix-forward (security MEDIUM): 캐시 키/ILIKE DoS 차단용 길이 클램프.
    const clampedQ = opts.q === undefined ? undefined : opts.q.slice(0, 200);
    const clampedCursor = opts.cursor === null ? null : opts.cursor.slice(0, 128);
    const cacheKey = await this.discoverCache.keyFor({
      category: opts.category,
      q: clampedQ,
      cursor: clampedCursor,
      limit: opts.limit,
    });
    const cached = await this.discoverCache.read<DiscoverPage>(cacheKey);
    if (cached !== null) {
      // 072 백로그 S-C 리뷰(LOW): 캐시에는 raw storageKey 가 들어 있으므로 반환 직전에
      // presigned GET URL 로 변환한다(만료 서명을 캐시에 박지 않기 위해 read 마다 변환).
      return { payload: await this.presignDiscoverPage(cached), cacheStatus: 'HIT' };
    }

    const capped = Math.max(1, Math.min(50, opts.limit));
    const q = (clampedQ ?? '').trim();
    const cat = (opts.category ?? '').trim();
    let cursorParts: { memberCount: number; id: string } | null = null;
    if (clampedCursor) {
      const [mc, id] = clampedCursor.split('|');
      if (mc && id) cursorParts = { memberCount: parseInt(mc, 10), id };
    }
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        slug: string;
        description: string | null;
        iconUrl: string | null;
        category: string;
        joinMode: string;
        memberCount: bigint;
        lastActivityAt: Date | null;
      }>
    >`
      SELECT
        w.id,
        w.name,
        w.slug,
        w.description,
        w."iconUrl",
        w.category::text AS category,
        -- S72 (FR-W16): joinMode 노출 — FE 가 카드 CTA(참가/신청/초대필요)를 분기한다.
        w."joinMode"::text AS "joinMode",
        COUNT(wm.*)::bigint AS "memberCount",
        MAX(m."createdAt") AS "lastActivityAt"
      FROM "Workspace" w
      LEFT JOIN "WorkspaceMember" wm ON wm."workspaceId" = w.id
      LEFT JOIN "Channel" c ON c."workspaceId" = w.id AND c."deletedAt" IS NULL
      LEFT JOIN "Message" m ON m."channelId" = c.id AND m."deletedAt" IS NULL
      WHERE w."deletedAt" IS NULL
        AND w.visibility = 'PUBLIC'
        AND w.category IS NOT NULL
        AND (${cat}::text = '' OR w.category::text = ${cat}::text)
        AND (
          ${q}::text = ''
          -- task-031-D: expand substring match to description.
          OR w.name ILIKE '%' || ${q}::text || '%'
          OR w.description ILIKE '%' || ${q}::text || '%'
        )
      GROUP BY w.id
      HAVING (
        ${cursorParts === null ? null : cursorParts.memberCount}::int IS NULL
        OR COUNT(wm.*)::int < ${cursorParts === null ? 0 : cursorParts.memberCount}::int
        OR (
          COUNT(wm.*)::int = ${cursorParts === null ? 0 : cursorParts.memberCount}::int
          AND w.id::text > ${cursorParts === null ? '' : cursorParts.id}::text
        )
      )
      -- task-031-D: tie-break on id ASC so (memberCount DESC, id ASC) is a
      -- total order and the HAVING cursor comparison matches ORDER BY.
      ORDER BY COUNT(wm.*) DESC, w.id ASC
      LIMIT ${capped + 1}
    `;
    const hasMore = rows.length > capped;
    const items = (hasMore ? rows.slice(0, capped) : rows).map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      iconUrl: r.iconUrl,
      // S72 (FR-W16): raw enum 텍스트(::text)를 shared-types 와 동일한 합집합으로 좁힌다.
      // WHERE 절이 category IS NOT NULL · visibility=PUBLIC 을 강제하므로 값은 유효 enum 이다.
      category: r.category as DiscoveryWorkspace['category'],
      joinMode: r.joinMode as DiscoveryWorkspace['joinMode'],
      memberCount: Number(r.memberCount),
      lastActivityAt: r.lastActivityAt ? r.lastActivityAt.toISOString() : null,
    }));
    const nextCursor = hasMore
      ? `${items[items.length - 1].memberCount}|${items[items.length - 1].id}`
      : null;
    const payload: DiscoverPage = { items, nextCursor };
    // 캐시에는 raw storageKey 가 든 payload 를 그대로 저장하고(서명 미포함), 반환 직전에만
    // presign 한다 — listMine/getWithMyRole 와 동일한 presign-on-read 불변식 유지.
    await this.discoverCache.write(cacheKey, payload);
    return { payload: await this.presignDiscoverPage(payload), cacheStatus: 'MISS' };
  }

  async joinPublic(
    workspaceId: string,
    userId: string,
    // S66 (D13 / FR-W05a): 도메인 가입(PUBLIC 즉시 가입) 시점 진입 게이트
    // (emailVerified + emailDomains). 컨트롤러가 JWT 에서 로드한 본인 값을 넘긴다.
    // S72 (D13 / FR-W22): clientIp(req.ip 계열)로 IP soft-block 대조 + 가입 ipHash 기록.
    actor: { emailVerified: boolean; userEmail: string; clientIp?: string | null },
  ): Promise<{ workspaceId: string; alreadyMember: boolean }> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        visibility: true,
        joinMode: true,
        deletedAt: true,
        // S66 (D13 / FR-W05a): 도메인 게이트용 화이트리스트.
        emailDomains: true,
      },
    });
    if (!ws || ws.deletedAt) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    if (ws.visibility !== 'PUBLIC') {
      throw new DomainError(
        ErrorCode.WORKSPACE_NOT_PUBLIC,
        'workspace is not joinable without invite',
      );
    }
    // S65 fix-forward (security A-2): joinMode=APPLY 면 즉시 가입을 차단한다. visibility
    // 와 joinMode 는 직교하므로 PUBLIC discover 노출 워크스페이스라도 가입 방식이 APPLY
    // 면 승인 게이트(FR-W06, S66 carryover)를 거쳐야 한다. 그 플로우가 구현되기 전까지
    // 즉시 가입으로 우회되면 승인 절차가 무력화되므로 명시적으로 거부한다.
    if (ws.joinMode === 'APPLY') {
      throw new DomainError(
        ErrorCode.WORKSPACE_APPLY_NOT_SUPPORTED,
        'workspace requires application approval — direct join is not supported yet',
      );
    }
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (existing) return { workspaceId, alreadyMember: true };
    // S66 (D13 / FR-W05a): emailVerified 재확인 직후 emailDomains exact-match 검증.
    // 미인증 → 403 EMAIL_NOT_VERIFIED, 도메인 불일치 → 403 WORKSPACE_DOMAIN_NOT_ALLOWED.
    // emailDomains 빈 배열이면 도메인 게이트 통과. ban 검사 전에 두어 미인증/도메인 불일치
    // 사용자가 가입 트랜잭션에 진입하지 않게 한다.
    assertWorkspaceEntryAllowed({
      emailVerified: actor.emailVerified,
      userEmail: actor.userEmail,
      emailDomains: ws.emailDomains,
    });
    // S63 fix-forward (security A-1 = HIGH/BLOCKER): 차단(BannedMember)된 userId 는 PUBLIC
    // 워크스페이스라도 즉시 가입할 수 없다. invites.accept 엔 차단 검사가 있었으나
    // joinPublic 누락으로 ban 우회 재가입이 가능했다. 차단 사실 누출을 막기 위해
    // 워크스페이스 미존재와 동일한 중립 404(WORKSPACE_NOT_FOUND)로 거부한다.
    if (await this.moderation.isBanned(workspaceId, userId)) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    // S72 (D13 / FR-W22): IP soft-block. PUBLIC 즉시 가입은 차단 IP 매칭이어도 hard-block
    // 하지 않고(NAT 공유 오탐 방지) 허용하되 SUSPICIOUS_JOIN 감사를 남긴다. 반환된 ipHash 를
    // 멤버 행에 기록해 이 사용자가 추후 ban 되면 같은 IP 가 BannedMember.ipHash 로 복사된다.
    const { ipHash } = await this.ipSoftBlock.assertNotIpBlocked({
      workspaceId,
      userId,
      clientIp: actor.clientIp,
      mechanism: 'PUBLIC',
    });
    // S61 fix-forward (security A-2 · MemberRole desync): 멤버 생성과 동일 트랜잭션에서
    // MEMBER 시스템 MemberRole 을 시드한다. 이게 없으면 신규 멤버는 MemberRole 부재로
    // computeActorTopPosition=0·computeActorMaxPermissions=0n 이 되어 ADMIN 승격 후에도
    // 역할 관리가 전부 거부된다(기능 불능).
    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.create({
        data: { workspaceId, userId, role: WorkspaceRole.MEMBER, ipHash },
      });
      await syncMemberSystemRole(tx, workspaceId, userId, 'MEMBER');
    });
    return { workspaceId, alreadyMember: false };
  }

  async softDelete(workspaceId: string, actorId: string, confirmation: string) {
    // task-013-A2 (task-034 closure): the purge worker that hard-
    // deletes post-grace rows lives at scripts/workers/
    // workspace-purge.sh (cron inside qufox-backup container,
    // daily at 05:00 UTC). This service is the soft-delete side
    // of that contract.
    //
    // S72 (D13 / FR-W15): 파괴적 액션 게이트 — 삭제하려면 워크스페이스 slug 를 정확히
    // 타이핑해야 한다. confirmation 을 실제 workspace.slug 와 대조해 불일치면 422
    // (WORKSPACE_CONFIRMATION_MISMATCH)로 거부한다(클라가 confirmation 을 위조해도
    // 서버가 실제 slug 로 대조하므로 우회 불가). 일치하면 기존 soft-delete 흐름
    // (deletedAt/deleteAt + 30일 grace + outbox WORKSPACE_DELETED)으로 진입한다.
    const target = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    });
    if (!target) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    if (confirmation !== target.slug) {
      throw new DomainError(
        ErrorCode.WORKSPACE_CONFIRMATION_MISMATCH,
        'confirmation must exactly match the workspace slug',
      );
    }
    const now = new Date();
    const deleteAt = new Date(now.getTime() + this.graceMs);
    const workspace = await this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.update({
        where: { id: workspaceId },
        data: { deletedAt: now, deleteAt },
      });
      await this.outbox.record(tx, {
        aggregateType: 'workspace',
        aggregateId: ws.id,
        eventType: WORKSPACE_DELETED,
        payload: { workspaceId: ws.id, actorId, deleteAt: deleteAt.toISOString() },
      });
      return ws;
    });
    // S72 (D13 / FR-W16): 삭제는 PUBLIC 워크스페이스를 discover 결과에서 제외시키므로
    // 검색 캐시를 무효화한다(다음 호출 MISS).
    await this.discoverCache.invalidate();
    return workspace;
  }

  async restore(workspaceId: string, actorId: string) {
    const current = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { deletedAt: true, deleteAt: true },
    });
    if (!current?.deletedAt || !current.deleteAt) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace is not deleted');
    }
    if (current.deleteAt.getTime() <= Date.now()) {
      throw new DomainError(
        ErrorCode.WORKSPACE_PURGED,
        'grace period elapsed — workspace is permanently gone',
      );
    }
    const workspace = await this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.update({
        where: { id: workspaceId },
        data: { deletedAt: null, deleteAt: null },
      });
      await this.outbox.record(tx, {
        aggregateType: 'workspace',
        aggregateId: ws.id,
        eventType: WORKSPACE_RESTORED,
        payload: { workspaceId: ws.id, actorId },
      });
      return ws;
    });
    // S72 (D13 / FR-W16): 복원은 PUBLIC 워크스페이스를 다시 discover 노출 대상으로
    // 되돌리므로 검색 캐시를 무효화한다.
    await this.discoverCache.invalidate();
    return workspace;
  }

  /**
   * Atomic transfer — demote old OWNER, promote new OWNER, flip ownerId, and
   * record the event all inside a single `$transaction`. An observer reading
   * `OutboxEvent` never sees the committed update without the matching event.
   */
  async transferOwnership(
    workspaceId: string,
    fromUserId: string,
    toUserId: string,
    password: string,
  ) {
    if (fromUserId === toUserId) {
      throw new DomainError(
        ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
        'cannot transfer ownership to yourself',
      );
    }
    // S65 (D13 / FR-W13 · ★결정 C): 소유권 양도는 OWNER 비밀번호 재확인을 강제한다.
    // 저장된 passwordHash 는 argon2 이므로 auth 와 동일한 PasswordService.verify 로
    // 검사한다. 불일치는 401(AUTH_INVALID_CREDENTIALS)로 거부한다 — 양도는 비가역적
    // 권한 이전이므로 세션 탈취만으로 실행되지 않도록 막는 보안 게이트다.
    const actor = await this.prisma.user.findUnique({
      where: { id: fromUserId },
      select: { passwordHash: true },
    });
    if (!actor || !(await this.passwords.verify(actor.passwordHash, password))) {
      throw new DomainError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'password confirmation failed');
    }
    // task-013-A2 (task-033 closure): two concurrent transferOwnership
    // calls against the same workspace would interleave under the
    // default READ COMMITTED isolation. Serializable forces the DB to
    // serialise them (losing tx retries with serialization_failure,
    // which Prisma surfaces as P2034); the TOCTOU gap between
    // findUnique and the three updates closes.
    const workspace = await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: toUserId } },
        });
        if (!target) {
          throw new DomainError(
            ErrorCode.WORKSPACE_TARGET_NOT_MEMBER,
            'target user is not a member of this workspace',
          );
        }
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: fromUserId } },
          data: { role: WorkspaceRole.ADMIN },
        });
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: toUserId } },
          data: { role: WorkspaceRole.OWNER },
        });
        // S61 fix-forward (security A-1 · privilege escalation): WorkspaceMember.role
        // enum 변경만으로는 시스템 MemberRole 이 desync 된다. ex-OWNER 가 OWNER
        // MemberRole(ADMINISTRATOR 비트)을 그대로 들고 있으면 자신에게 god role 을
        // 재부여해 OWNER 권한을 되찾을 수 있으므로, MemberRole 도 같은 트랜잭션에서
        // 교체한다 — fromUserId 는 OWNER→ADMIN, toUserId 는 (기존 등급)→OWNER.
        await syncMemberSystemRole(tx, workspaceId, fromUserId, 'ADMIN');
        await syncMemberSystemRole(tx, workspaceId, toUserId, 'OWNER');
        const ws = await tx.workspace.update({
          where: { id: workspaceId },
          data: { ownerId: toUserId },
        });
        await this.outbox.record(tx, {
          aggregateType: 'workspace',
          aggregateId: workspaceId,
          eventType: OWNERSHIP_TRANSFERRED,
          payload: { workspaceId, fromUserId, toUserId },
        });
        return ws;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    // S62 fix-forward (security A-1 = MAJOR-1 / MEDIUM-2): from/to 두 멤버 모두 역할이
    // 바뀌었으므로 두 멤버의 채널별 권한 캐시를 모두 DEL 해 이양 후 stale 권한
    // (ex-OWNER 가 ADMINISTRATOR 캐시로 ≤5초간 우회)을 즉시 닫는다. best-effort.
    await this.memberRoles.invalidateMemberPermsCache(workspaceId, fromUserId);
    await this.memberRoles.invalidateMemberPermsCache(workspaceId, toUserId);
    return workspace;
  }

  /**
   * S65 (D13 / FR-W19): 워크스페이스 기본 채널을 변경한다(OWNER 게이트는 컨트롤러).
   * 대상은 같은 워크스페이스의 살아있는 공개 채널(isPrivate=false·deletedAt=null)이어야
   * 한다 — 가입자 랜딩 채널은 모두가 접근 가능해야 하기 때문이다. 이전 기본 채널의
   * isDefault 를 false 로 해제하고 신규 채널을 true 로 올린 뒤 Workspace.defaultChannelId
   * 를 갱신하는 세 작업을 단일 트랜잭션으로 묶는다(원자성). 멱등 — 이미 기본인 채널을
   * 다시 지정해도 안전하다.
   */
  async updateDefaultChannel(workspaceId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, deletedAt: null },
      select: { id: true, isPrivate: true, isDefault: true },
    });
    if (!channel) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found in this workspace');
    }
    if (channel.isPrivate) {
      throw new DomainError(
        ErrorCode.WORKSPACE_DEFAULT_CHANNEL_NOT_PUBLIC,
        'default channel must be a public channel',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      // 이전 기본 채널들(보통 0~1개)의 isDefault 를 해제한다 — 대상 채널은 제외해
      // 멱등 재지정에서도 깜빡임 없이 true 를 유지한다.
      await tx.channel.updateMany({
        where: { workspaceId, isDefault: true, id: { not: channelId } },
        data: { isDefault: false },
      });
      await tx.channel.update({
        where: { id: channelId },
        data: { isDefault: true },
      });
      return tx.workspace.update({
        where: { id: workspaceId },
        data: { defaultChannelId: channelId },
      });
    });
  }

  /** Used by guards/services that want to confirm caller is OWNER. */
  isOwner(role: string): boolean {
    return ROLE_RANK[role as SharedWorkspaceRole] === ROLE_RANK.OWNER;
  }
}
