import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectMessagesService } from './direct-messages.service';
import { ErrorCode } from '../../common/errors/error-code.enum';
import type { PrismaService } from '../../prisma/prisma.module';
import type { OutboxService } from '../../common/outbox/outbox.service';
import type { S3Service } from '../../storage/s3.service';

/**
 * S77a (D14 / FR-PS-13, HIGH-1 fix-forward): DM 수신권한 게이트(assertDmPrivacyAllows)의 순수
 * 도메인 단위 테스트 — **도달 경로**(createOrGetGlobal → POST /me/dms)를 통해 검증한다. 외부
 * (Prisma / Outbox / S3)는 vi.fn() 으로만 모킹. 시간 고정(2025-01-01).
 *
 * createOrGetGlobal 호출 순서:
 *   1) assertCanDm        → friendship.findFirst (ACCEPTED 아니면 FRIEND_NOT_FOUND).
 *   2) assertDmPrivacyAllows → user.findUnique(allowDmFrom + settings.allowDmFromWorkspaceMembers)
 *                              + (필요 시) friendship.findFirst + workspaceMember.findFirst.
 *   3) createOrGetWorkspaceless → channel.findFirst + $transaction.
 *
 * 검증 매트릭스(allowDmFromWorkspaceMembers 게이트):
 *   - 친구 ACCEPTED + allowDmFromWorkspaceMembers=false → 허용(친구는 워크스페이스 토글 무관 상위 신뢰).
 *   - 기존 채널이 있으면 게이트 무관하게 그대로 반환(created=false) — 새 대화 개시만 게이트 대상.
 *   - 친구가 아니면 전역 경로의 친구 게이트(assertCanDm)가 우선 차단(FRIEND_NOT_FOUND).
 *   - 게이트의 차단 분기 자체(WORKSPACE_MEMBER + 공통 ws + 토글 false + 비-친구 → DM_PRIVACY_RESTRICTED)
 *     는 createGroupDm(workspaceId=null) 경로의 멤버 게이트로 검증한다(int 보강).
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ME = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

function fakeOutbox(): OutboxService {
  return { record: vi.fn().mockResolvedValue('outbox-id') } as unknown as OutboxService;
}
function fakeS3(): S3Service {
  return {
    putObject: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  } as unknown as S3Service;
}

interface GateOpts {
  // assertCanDm + assertDmPrivacyAllows 둘 다 friendship.findFirst 를 호출한다.
  // assertCanDm: status 반환(ACCEPTED 면 통과). assertDmPrivacyAllows: ACCEPTED row 면 통과.
  friend: boolean;
  // target.allowDmFrom — 기본 WORKSPACE_MEMBER(스키마 default).
  allowDmFrom: 'EVERYONE' | 'WORKSPACE_MEMBER';
  // target.settings.allowDmFromWorkspaceMembers — null 이면 행 부재(기본 true).
  allowWorkspaceDm: boolean | null;
  // 공통 워크스페이스 존재 여부(workspaceMember.findFirst).
  sharedWorkspace: boolean;
  // 기존 DM 채널 존재 여부(channel.findFirst).
  existingChannel: boolean;
}

function makeService(opts: GateOpts): {
  service: DirectMessagesService;
  channelCreate: ReturnType<typeof vi.fn>;
} {
  const channelCreate = vi.fn().mockResolvedValue({ id: 'ch-new' });
  const friendshipFindFirst = vi.fn().mockImplementation(async (args: { where?: unknown }) => {
    if (!opts.friend) return null;
    // assertCanDm 은 { status } 만, assertDmPrivacyAllows 는 { id } 만 select 하지만
    // 두 필드를 모두 돌려줘도 무방하다(둘 다 ACCEPTED 로 판정).
    void args;
    return { id: 'fr1', status: 'ACCEPTED' };
  });
  const channel = {
    findFirst: vi.fn().mockResolvedValue(opts.existingChannel ? { id: 'ch-existing' } : null),
    create: channelCreate,
  };
  const channelPermissionOverride = { create: vi.fn().mockResolvedValue(undefined) };
  const prisma = {
    channel,
    channelPermissionOverride,
    user: {
      findUnique: vi.fn().mockResolvedValue({
        allowDmFrom: opts.allowDmFrom,
        settings:
          opts.allowWorkspaceDm === null
            ? null
            : { allowDmFromWorkspaceMembers: opts.allowWorkspaceDm },
      }),
    },
    friendship: { findFirst: friendshipFindFirst },
    workspaceMember: {
      findFirst: vi.fn().mockResolvedValue(opts.sharedWorkspace ? { workspaceId: 'ws1' } : null),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ channel, channelPermissionOverride }),
    ),
  } as unknown as PrismaService;
  return {
    service: new DirectMessagesService(prisma, fakeOutbox(), fakeS3()),
    channelCreate,
  };
}

describe('S77a DM privacy gate via reachable createOrGetGlobal', () => {
  it('ACCEPTED friend + allowDmFromWorkspaceMembers=false → DM creation allowed (friend overrides toggle)', async () => {
    const { service, channelCreate } = makeService({
      friend: true,
      allowDmFrom: 'WORKSPACE_MEMBER',
      allowWorkspaceDm: false,
      sharedWorkspace: true,
      existingChannel: false,
    });
    const res = await service.createOrGetGlobal(ME, TARGET);
    expect(res.created).toBe(true);
    expect(channelCreate).toHaveBeenCalledTimes(1);
  });

  it('existing channel is returned unchanged regardless of allowDmFromWorkspaceMembers (no gate on existing)', async () => {
    const { service, channelCreate } = makeService({
      friend: true,
      allowDmFrom: 'WORKSPACE_MEMBER',
      allowWorkspaceDm: false,
      sharedWorkspace: false,
      existingChannel: true,
    });
    const res = await service.createOrGetGlobal(ME, TARGET);
    expect(res).toEqual({ channelId: 'ch-existing', created: false });
    expect(channelCreate).not.toHaveBeenCalled();
  });

  it('non-friend is blocked by the friend gate first (FRIEND_NOT_FOUND) on the global path', async () => {
    const { service, channelCreate } = makeService({
      friend: false,
      allowDmFrom: 'WORKSPACE_MEMBER',
      allowWorkspaceDm: false,
      sharedWorkspace: true,
      existingChannel: false,
    });
    await expect(service.createOrGetGlobal(ME, TARGET)).rejects.toMatchObject({
      code: ErrorCode.FRIEND_NOT_FOUND,
    });
    expect(channelCreate).not.toHaveBeenCalled();
  });

  it('allowDmFrom=EVERYONE always allows (toggle is irrelevant when DM is open to everyone)', async () => {
    const { service, channelCreate } = makeService({
      friend: true,
      allowDmFrom: 'EVERYONE',
      allowWorkspaceDm: false,
      sharedWorkspace: false,
      existingChannel: false,
    });
    const res = await service.createOrGetGlobal(ME, TARGET);
    expect(res.created).toBe(true);
    expect(channelCreate).toHaveBeenCalledTimes(1);
  });
});
