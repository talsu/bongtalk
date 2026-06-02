import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelAccessService } from '../../../src/channels/permission/channel-access.service';
import { PERMISSIONS } from '@qufox/shared-types';

/**
 * S44 (FR-MN-02 / FR-MN-16 / ADR-4): MENTION_EVERYONE(카탈로그 비트 0x0080)
 * override 5단계 fold 단위 검증. base → roleAllow → roleDeny → userAllow →
 * userDeny. base 는 역할 기본값(OWNER/ADMIN on, MEMBER off).
 *
 * vi.fn() 만 사용(외부 모킹 라이브러리 금지) — prisma 의
 * channelPermissionOverride.findMany 만 스텁한다.
 */
const BIT = Number(PERMISSIONS.MENTION_EVERYONE); // 0x0080

type Override = {
  principalType: 'USER' | 'ROLE';
  principalId: string;
  allowMask: number;
  denyMask: number;
};

function makeService(overrides: Override[]): ChannelAccessService {
  const findMany = vi.fn().mockResolvedValue(overrides);
  const prisma = { channelPermissionOverride: { findMany } } as unknown as ConstructorParameters<
    typeof ChannelAccessService
  >[0];
  return new ChannelAccessService(prisma);
}

const CH = { id: 'ch1', workspaceId: 'ws1' };
const UID = 'user-1';

describe('ChannelAccessService.resolveMentionEveryone (S44 ADR-4 fold)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('기본 MEMBER 는 override 없으면 차단(false)', async () => {
    const svc = makeService([]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'MEMBER')).resolves.toBe(false);
  });

  it('기본 OWNER / ADMIN 은 override 없으면 허용(true)', async () => {
    await expect(makeService([]).resolveMentionEveryone(CH, UID, 'OWNER')).resolves.toBe(true);
    await expect(makeService([]).resolveMentionEveryone(CH, UID, 'ADMIN')).resolves.toBe(true);
  });

  it('MEMBER + ROLE allow override → 허용', async () => {
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: BIT, denyMask: 0 },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'MEMBER')).resolves.toBe(true);
  });

  it('MEMBER + USER allow override → 허용', async () => {
    const svc = makeService([
      { principalType: 'USER', principalId: UID, allowMask: BIT, denyMask: 0 },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'MEMBER')).resolves.toBe(true);
  });

  it('OWNER + USER deny override → 차단(개인 DENY 가 역할 base 를 이김)', async () => {
    const svc = makeService([
      { principalType: 'USER', principalId: UID, allowMask: 0, denyMask: BIT },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'OWNER')).resolves.toBe(false);
  });

  it('ADMIN + ROLE deny override → 차단', async () => {
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'ADMIN', allowMask: 0, denyMask: BIT },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'ADMIN')).resolves.toBe(false);
  });

  it('MEMBER + ROLE allow + USER deny → 차단(개인 DENY > 역할 ALLOW)', async () => {
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: BIT, denyMask: 0 },
      { principalType: 'USER', principalId: UID, allowMask: 0, denyMask: BIT },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'MEMBER')).resolves.toBe(false);
  });

  it('MEMBER + ROLE deny + USER allow → 허용(개인 ALLOW > 역할 DENY)', async () => {
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: 0, denyMask: BIT },
      { principalType: 'USER', principalId: UID, allowMask: BIT, denyMask: 0 },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'MEMBER')).resolves.toBe(true);
  });

  it('다른 비트(PIN_MESSAGE 0x80 enforcement 가 아닌 무관 비트)만 켠 allow 는 영향 없음', async () => {
    // 카탈로그 SEND_MESSAGES(0x0002) 등 MENTION_EVERYONE 외 비트만 켠 override 는
    // MENTION_EVERYONE 판정에 무관해야 한다(비트 마스킹 격리 확인).
    const other = Number(PERMISSIONS.SEND_MESSAGES);
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: other, denyMask: 0 },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'MEMBER')).resolves.toBe(false);
  });

  it('DM 채널(workspaceId=null)은 항상 false', async () => {
    const svc = makeService([
      { principalType: 'USER', principalId: UID, allowMask: BIT, denyMask: 0 },
    ]);
    await expect(
      svc.resolveMentionEveryone({ id: 'dm1', workspaceId: null }, UID, 'MEMBER'),
    ).resolves.toBe(false);
  });
});
