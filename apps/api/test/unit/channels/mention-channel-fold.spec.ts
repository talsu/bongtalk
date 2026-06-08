import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelAccessService } from '../../../src/channels/permission/channel-access.service';
import { PERMISSIONS } from '@qufox/shared-types';

/**
 * S94 (067 / FR-MSG-14 / ADR-4): MENTION_CHANNEL(카탈로그 비트 0x2000) override
 * 5단계 fold 단위 검증. base → roleAllow → roleDeny → userAllow → userDeny.
 *
 * Option B: @channel/@here 는 @everyone(MENTION_EVERYONE) 과 분리된 별도 권한 비트로,
 * base 가 OWNER/ADMIN/MODERATOR/MEMBER 모두 ON(GUEST 만 off) 이라 일반 MEMBER 도 기본
 * 허용된다. 채널 override deny 로 역할/멤버별 박탈할 수 있다.
 *
 * vi.fn() 만 사용(외부 모킹 라이브러리 금지) — channelPermissionOverride.findMany 만 스텁.
 */
const CHANNEL_BIT = Number(PERMISSIONS.MENTION_CHANNEL); // 0x2000
const EVERYONE_BIT = Number(PERMISSIONS.MENTION_EVERYONE); // 0x0080

type Override = {
  principalType: 'USER' | 'ROLE';
  principalId: string;
  allowMask: number;
  denyMask: number;
};

function makeService(overrides: Override[]): ChannelAccessService {
  const findMany = vi.fn().mockResolvedValue(overrides);
  const prisma = {
    channelPermissionOverride: { findMany },
    memberRole: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as ConstructorParameters<typeof ChannelAccessService>[0];
  const audit = {
    recordBestEffort: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof ChannelAccessService>[1];
  return new ChannelAccessService(prisma, audit);
}

const CH = { id: 'ch1', workspaceId: 'ws1' };
const UID = 'user-1';

describe('ChannelAccessService.resolveMentionScopes (S94 / FR-MSG-14 MENTION_CHANNEL fold)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('비트 위치 사전 단언: MENTION_CHANNEL=0x2000, MENTION_EVERYONE=0x0080, 비겹침', () => {
    expect(CHANNEL_BIT).toBe(0x2000);
    expect(EVERYONE_BIT).toBe(0x0080);
    expect(CHANNEL_BIT & EVERYONE_BIT).toBe(0);
  });

  it('기본 MEMBER 는 override 없이 @channel/@here 허용(hasMentionChannel=true)이고 @everyone 차단', async () => {
    const svc = makeService([]);
    const scopes = await svc.resolveMentionScopes(CH, UID, 'MEMBER');
    expect(scopes.hasMentionChannel).toBe(true);
    expect(scopes.hasMentionEveryone).toBe(false);
  });

  it('GUEST 는 override 없으면 @channel 도 차단(보수적 base off)', async () => {
    const svc = makeService([]);
    const scopes = await svc.resolveMentionScopes(CH, UID, 'GUEST');
    expect(scopes.hasMentionChannel).toBe(false);
    expect(scopes.hasMentionEveryone).toBe(false);
  });

  it('OWNER/ADMIN/MODERATOR 는 override 없이 둘 다 허용', async () => {
    for (const role of ['OWNER', 'ADMIN', 'MODERATOR'] as const) {
      const scopes = await makeService([]).resolveMentionScopes(CH, UID, role);
      expect(scopes.hasMentionChannel).toBe(true);
      expect(scopes.hasMentionEveryone).toBe(true);
    }
  });

  it('채널 ROLE deny(MENTION_CHANNEL) override → MEMBER @channel 박탈', async () => {
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: 0, denyMask: CHANNEL_BIT },
    ]);
    const scopes = await svc.resolveMentionScopes(CH, UID, 'MEMBER');
    expect(scopes.hasMentionChannel).toBe(false);
    // @everyone 비트는 영향 없음(여전히 MEMBER base off).
    expect(scopes.hasMentionEveryone).toBe(false);
  });

  it('USER deny(MENTION_CHANNEL) override → 개인 DENY 가 base 를 이김(OWNER 도 @channel 박탈)', async () => {
    const svc = makeService([
      { principalType: 'USER', principalId: UID, allowMask: 0, denyMask: CHANNEL_BIT },
    ]);
    const scopes = await svc.resolveMentionScopes(CH, UID, 'OWNER');
    expect(scopes.hasMentionChannel).toBe(false);
    // @everyone 은 OWNER base on 이라 그대로 true(비트 격리 — MENTION_CHANNEL deny 무관).
    expect(scopes.hasMentionEveryone).toBe(true);
  });

  it('GUEST + ROLE allow(MENTION_CHANNEL) → @channel 허용', async () => {
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'GUEST', allowMask: CHANNEL_BIT, denyMask: 0 },
    ]);
    const scopes = await svc.resolveMentionScopes(CH, UID, 'GUEST');
    expect(scopes.hasMentionChannel).toBe(true);
  });

  it('두 비트가 한 override 에 함께 켜져도 독립 fold(allow EVERYONE+CHANNEL → 둘 다 true)', async () => {
    const svc = makeService([
      {
        principalType: 'USER',
        principalId: UID,
        allowMask: EVERYONE_BIT | CHANNEL_BIT,
        denyMask: 0,
      },
    ]);
    const scopes = await svc.resolveMentionScopes(CH, UID, 'MEMBER');
    expect(scopes.hasMentionEveryone).toBe(true);
    expect(scopes.hasMentionChannel).toBe(true);
  });

  it('@everyone deny 가 @channel 에 누설되지 않음(deny EVERYONE 만 → channel 은 MEMBER base 유지)', async () => {
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: 0, denyMask: EVERYONE_BIT },
    ]);
    const scopes = await svc.resolveMentionScopes(CH, UID, 'MEMBER');
    expect(scopes.hasMentionEveryone).toBe(false);
    expect(scopes.hasMentionChannel).toBe(true); // MENTION_CHANNEL 비트는 deny 대상 아님.
  });

  it('DM 채널(workspaceId=null)은 두 권한 모두 false', async () => {
    const svc = makeService([
      { principalType: 'USER', principalId: UID, allowMask: CHANNEL_BIT, denyMask: 0 },
    ]);
    const scopes = await svc.resolveMentionScopes({ id: 'dm1', workspaceId: null }, UID, 'MEMBER');
    expect(scopes.hasMentionChannel).toBe(false);
    expect(scopes.hasMentionEveryone).toBe(false);
  });

  it('resolveMentionEveryone 은 resolveMentionScopes.hasMentionEveryone 과 동일(위임 보존)', async () => {
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: EVERYONE_BIT, denyMask: 0 },
    ]);
    const everyone = await svc.resolveMentionEveryone(CH, UID, 'MEMBER');
    const scopes = await svc.resolveMentionScopes(CH, UID, 'MEMBER');
    expect(everyone).toBe(scopes.hasMentionEveryone);
    expect(everyone).toBe(true);
  });
});
