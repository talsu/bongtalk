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

  it('MENTION_EVERYONE 외 무관 비트(SEND_MESSAGES 0x0002)만 켠 allow 는 영향 없음', async () => {
    // 카탈로그 SEND_MESSAGES(0x0002)는 MENTION_EVERYONE(0x0080)과 비트 위치가
    // 달라 판정에 무관해야 한다(비트 마스킹 격리 — 오프-바이 비트 회귀 방어).
    const other = Number(PERMISSIONS.SEND_MESSAGES);
    expect(other & BIT).toBe(0); // 사전 단언: 두 비트는 겹치지 않는다.
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: other, denyMask: 0 },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'MEMBER')).resolves.toBe(false);
  });

  // S44 fix-forward (test · 0x80 dead-bit 문서화): 집행 enum(auth/permissions.ts)의
  // 0x0080 은 PIN_MESSAGE 인데, **PIN_MESSAGE 는 어디서도 hasPermission/require 로
  // 집행되지 않는 dead bit** 다 — pin/unpin 은 컨트롤러의 OWNER/ADMIN 역할 검사로만
  // 게이트되어 0x0080 비트는 권한 판정 경로에 등장하지 않는다. 따라서 카탈로그
  // MENTION_EVERYONE 이 같은 0x0080 비트를 재사용해도 PIN_MESSAGE 집행과 충돌하지
  // 않는다(S40 MANAGE_CHANNEL 0x0020 선례와 동일 패턴). 아래 두 테스트는 종전의
  // 오라벨 테스트(실제로는 0x02 를 써 0x80 격리를 검증하지 못한 위양성)를 대체해,
  // override 에 켠 **실제 0x0080 비트**가 MENTION_EVERYONE 권한으로 해석됨을
  // 명시적으로 고정한다. (전면 분리는 D12 carryover — PIN_MESSAGE 미집행이라 현재 무해.)
  it('override 의 실제 0x0080(=MENTION_EVERYONE 카탈로그=dead PIN_MESSAGE) allow → MEMBER 허용', async () => {
    expect(BIT).toBe(0x0080); // 카탈로그 MENTION_EVERYONE 비트는 0x0080.
    const svc = makeService([
      { principalType: 'ROLE', principalId: 'MEMBER', allowMask: 0x0080, denyMask: 0 },
    ]);
    // 0x0080 비트가 켜진 allow override 는 MENTION_EVERYONE 부여로 해석된다.
    await expect(svc.resolveMentionEveryone(CH, UID, 'MEMBER')).resolves.toBe(true);
  });

  it('override 의 실제 0x0080 deny → OWNER 도 차단(개인 DENY 가 역할 base 를 이김)', async () => {
    const svc = makeService([
      { principalType: 'USER', principalId: UID, allowMask: 0, denyMask: 0x0080 },
    ]);
    await expect(svc.resolveMentionEveryone(CH, UID, 'OWNER')).resolves.toBe(false);
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
